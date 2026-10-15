import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { createApiKey } from '../db/api-key.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, resetDatabase } from '../test/database.js';
import type { Database } from '../db/database.js';

describe('aproximações por HTTP', () => {
  let db: Database;
  let app: FastifyInstance;
  const now = new Date('2026-10-12T23:59:59Z');
  let apiKey: string;
  beforeAll(async () => { db = createTestDatabase(); app = await buildApp({ db, now: () => now }); await app.ready(); });
  beforeEach(async () => { await resetDatabase(db); apiKey = (await createApiKey(db, 'aproximações test', now)).key; });
  const request = (url: string) => app.inject({ url, headers: { authorization: `Bearer ${apiKey}` } });
  afterAll(async () => { await app?.close(); await db?.destroy(); });
  const seed = async (date: string, jplId = '2000433', hazardous = false) => {
    const asteroid = await db.insertInto('asteroid').values({ jpl_id: jplId, name: `Asteroid ${jplId}`, is_potentially_hazardous: hazardous,
      absolute_magnitude_h: 12.3, estimated_diameter_min_km: 1, estimated_diameter_max_km: 2,
      raw: { secret: true }, first_seen_at: now, last_seen_at: now }).onConflict((oc) => oc.column('jpl_id').doUpdateSet({ is_potentially_hazardous: hazardous })).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('close_approach').values({ asteroid_id: asteroid.id, date, approach_at: `${date}T12:00:00Z`, miss_distance_km: 1234,
      relative_velocity_kms: 5.6, orbiting_body: 'Earth', raw: { secret: true }, first_seen_at: now, last_seen_at: now }).execute();
  };
  it('defaults to the UTC date through six days later and serves typed asteroid summaries with NeoWs credit', async () => {
    for (const date of ['2026-10-11', '2026-10-12', '2026-10-18', '2026-10-19']) await seed(date);
    await db.insertInto('ingestion_run').values({ source: 'neows', status: 'succeeded', finished_at: '2026-10-10T23:59:58Z' }).execute();
    const response = await request('/v1/close-approaches');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.map((row: { date: string }) => row.date)).toEqual(['2026-10-12', '2026-10-18']);
    expect(body.data[0]).toMatchObject({ date: '2026-10-12', miss_distance_km: 1234, relative_velocity_kms: 5.6, orbiting_body: 'Earth',
      asteroid: { id: '2000433', name: 'Asteroid 2000433', absolute_magnitude_h: 12.3, estimated_diameter_min_km: 1, estimated_diameter_max_km: 2, is_potentially_hazardous: false } });
    expect(body.data[0]).not.toHaveProperty('raw'); expect(body.data[0].asteroid).not.toHaveProperty('raw');
    expect(body.meta.sources[0]).toMatchObject({ name: 'neows', stale: true, data_as_of: '2026-10-10T23:59:58.000Z' });
    expect(body.meta.sources[0].attribution).toContain('NASA/JPL');
  });
  it('filters inclusive calendar windows and hazardous asteroids, rejecting invalid dates and oversized windows', async () => {
    await seed('2026-10-12', 'danger', true); await seed('2026-10-12', 'safe'); await seed('2026-10-13', 'later', true);
    const response = await request('/v1/close-approaches?from=2026-10-12&to=2026-10-12&hazardous=true');
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((row: { asteroid: { id: string } }) => row.asteroid.id)).toEqual(['danger']);
    expect((await request('/v1/close-approaches?from=2026-10-12&to=2026-10-12&hazardous=false')).json().data).toHaveLength(2);
    expect((await request('/v1/close-approaches?from=2024-01-01&to=2024-12-31')).statusCode).toBe(200);
    for (const query of ['from=2024-01-01&to=2025-01-01', 'from=2026-10-13&to=2026-10-12', 'from=2026-02-30', 'from=0000-01-01', 'from=2026-2-01', 'to=2026-10-12T12:00:00Z', 'hazardous=maybe', 'limit=201', 'limit=0']) {
      const invalid = await request(`/v1/close-approaches?${query}`);
      expect(invalid.statusCode).toBe(400); expect(invalid.headers['content-type']).toContain('application/problem+json');
      expect(invalid.json().code).toBe('invalid_input');
    }
  });

  it('reports the stored date coverage even outside the requested window or hazardous filter', async () => {
    const empty = await request('/v1/close-approaches');
    expect(empty.json().meta.coverage).toEqual({ from: null, to: null });
    expect(empty.json().meta.next_cursor).toBeNull();
    await seed('2026-10-01'); await seed('2026-10-20');
    const response = await request('/v1/close-approaches?from=2026-11-01&to=2026-11-05&hazardous=true');
    expect(response.json().data).toEqual([]);
    expect(response.json().meta.coverage).toEqual({ from: '2026-10-01', to: '2026-10-20' });
  });

  it('validates cached data with the last successful coleta', async () => {
    await db.insertInto('ingestion_run').values({ source: 'neows', status: 'succeeded', finished_at: '2026-10-10T23:59:58Z' }).execute();
    const first = await request('/v1/close-approaches');
    const firstEtag = first.headers.etag;
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-cache');
    expect(firstEtag).toEqual(expect.any(String));

    const unchanged = await app.inject({ url: '/v1/close-approaches', headers: { authorization: `Bearer ${apiKey}`, 'if-none-match': firstEtag! } });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe('');
    expect(unchanged.headers.etag).toBe(firstEtag);

    await db.insertInto('ingestion_run').values({ source: 'neows', status: 'succeeded', finished_at: '2026-10-11T23:59:58Z' }).execute();
    const refreshed = await request('/v1/close-approaches');
    expect(refreshed.headers.etag).not.toBe(firstEtag);

    await db.insertInto('ingestion_run').values({ source: 'neows', status: 'failed', finished_at: '2026-10-12T22:59:58Z' }).execute();
    const afterFailure = await request('/v1/close-approaches');
    expect(afterFailure.headers.etag).toBe(refreshed.headers.etag);
  });

  it('paginates dates and equal dates with stable ids, and rejects malformed or mismatched cursors', async () => {
    await seed('2026-10-13', 'later'); await seed('2026-10-12', 'first'); await seed('2026-10-12', 'second');
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const pageUrl: string = `/v1/close-approaches?limit=1${cursor ? `&cursor=${cursor}` : ''}`;
      const response = await request(pageUrl); expect(response.statusCode).toBe(200);
      seen.push(...response.json().data.map((row: { asteroid: { id: string } }) => row.asteroid.id));
      cursor = response.json().meta.next_cursor;
    } while (cursor);
    expect(seen).toEqual(['first', 'second', 'later']);
    const first = await request('/v1/close-approaches?limit=1');
    const next = first.json().meta.next_cursor;
    for (const query of ['cursor=not-json', `cursor=${Buffer.from('{}').toString('base64url')}`, `cursor=${next}&hazardous=true`, `cursor=${next}&from=2026-10-13`, `cursor=${next}&to=2026-10-17`]) {
      const invalid = await request(`/v1/close-approaches?${query}`);
      expect(invalid.statusCode).toBe(400); expect(invalid.headers['content-type']).toContain('application/problem+json');
      expect(invalid.json().code).toBe('invalid_cursor');
    }
    expect((await request(`/v1/close-approaches?from=2026-10-12&to=2026-10-18&hazardous=false&limit=2&cursor=${next}`)).json().data).toHaveLength(2);
  });

  it('defaults to 50, supports 200, and preserves missing measurements as null', async () => {
    const asteroids = await db.insertInto('asteroid').values(Array.from({ length: 201 }, (_, index) => ({
      jpl_id: String(3000000 + index), name: `Asteroid ${index}`, is_potentially_hazardous: false,
      raw: {}, first_seen_at: now, last_seen_at: now,
    }))).returning('id').execute();
    await db.insertInto('close_approach').values(asteroids.map((asteroid) => ({
      asteroid_id: asteroid.id, date: '2026-10-12', approach_at: now, raw: {}, first_seen_at: now, last_seen_at: now,
    }))).execute();
    const first = await request('/v1/close-approaches');
    expect(first.json().data).toHaveLength(50); expect(first.json().meta.next_cursor).toEqual(expect.any(String));
    expect(first.json().data[0]).toMatchObject({ miss_distance_km: null, relative_velocity_kms: null, orbiting_body: null,
      asteroid: { absolute_magnitude_h: null, estimated_diameter_min_km: null, estimated_diameter_max_km: null } });
    expect((await request('/v1/close-approaches?limit=200')).json().data).toHaveLength(200);
  });

});
