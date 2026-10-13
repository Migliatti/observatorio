import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import { buildApp } from '../api/app.js';
import { createApiKey } from '../db/api-key.js';
import { createTestDatabase, resetDatabase } from '../test/database.js';
import { exoplanetArchiveCollector } from '../collect/exoplanet-archive.js';
import { runCollection } from '../collect/run.js';

const first = readFileSync(new URL('../sources/fixtures/exoplanet-archive/pscomppars.json', import.meta.url), 'utf8');
const later = readFileSync(new URL('../sources/fixtures/exoplanet-archive/pscomppars-later.json', import.meta.url), 'utf8');
const historyUrl = '/v1/exoplanets/HD%202039%20b/revisions';

describe('exoplanet revisions over HTTP', () => {
  let db: Database;
  let app: FastifyInstance;
  const now = new Date('2026-10-12T12:00:00Z');
  beforeAll(async () => { db = createTestDatabase(); app = await buildApp({ db, now: () => now }); await app.ready(); });
  let key: string;
  beforeEach(async () => { await resetDatabase(db); key = (await createApiKey(db, 'revision test', now)).key; });
  const get = (url: string) => app.inject({ url, headers: { authorization: `Bearer ${key}` } });
  afterAll(async () => { await app.close(); await db.destroy(); });
  const collect = async (body: string, date: string) => runCollection(db, 'exoplanet-archive', exoplanetArchiveCollector({ fetch: async () => new Response(body) }), () => new Date(date));

  it('serves stored typed snapshots newest first and compares against the previous historical revision', async () => {
    await collect(first, '2026-10-01T00:00:00Z');
    await collect(later, '2026-10-02T00:00:00Z');
    await collect(first, '2026-10-03T00:00:00Z');
    const response = await get(historyUrl);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({ parameters: { name: 'HD 2039 b', mass_earth_masses: 2010 }, recorded_at: '2026-10-03T00:00:00.000Z', changed_fields: ['mass_earth_masses'] });
    expect(body.data[1]).toMatchObject({ parameters: { mass_earth_masses: 1999.1507, insolation_earth_flux: 0.3229 }, recorded_at: '2026-10-02T00:00:00.000Z', changed_fields: [] });
    expect(body.data[0].parameters).not.toHaveProperty('raw');
    expect(body.data[0]).not.toHaveProperty('content_hash');
    expect(body.meta).toMatchObject({ next_cursor: null, sources: [{ name: 'exoplanet-archive', data_as_of: '2026-10-03T00:00:00.000Z', stale: true }] });
    expect(body.meta.sources[0].attribution).toContain('NASA Exoplanet Archive');
  });
  it('paginates tied timestamps and keeps historical differences across page boundaries while new revisions arrive', async () => {
    await collect(first, '2026-10-01T00:00:00Z');
    await collect(later, '2026-10-02T00:00:00Z');
    await collect(first, '2026-10-02T00:00:00Z');
    await collect(later, '2026-10-02T00:00:00Z');
    const initial = await get(`${historyUrl}?limit=1`);
    expect(initial.json().data).toHaveLength(1);
    expect(initial.json().data[0].changed_fields).toEqual(['mass_earth_masses']);
    const seen = [...initial.json().data];
    let cursor: string | null = initial.json().meta.next_cursor;
    expect(cursor).toBeTypeOf('string');
    await collect(first, '2026-10-01T12:00:00Z'); // Backdated append must also stay outside the original history.
    while (cursor) {
      const response = await get(`${historyUrl}?limit=1&cursor=${cursor}`);
      expect(response.statusCode).toBe(200);
      seen.push(...response.json().data);
      cursor = response.json().meta.next_cursor;
    }
    expect(seen.map((revision) => revision.parameters.mass_earth_masses)).toEqual([1999.1507, 2010, 1999.1507]);
    expect(seen.map((revision) => revision.changed_fields)).toEqual([['mass_earth_masses'], ['mass_earth_masses'], []]);
    expect(new Set(seen.map((revision) => revision.id)).size).toBe(3);
  });

  it('distinguishes an empty history from an absent or removed exoplanet', async () => {
    await collect(first, '2026-10-01T00:00:00Z');
    const empty = await get(historyUrl);
    expect(empty.statusCode).toBe(200);
    expect(empty.json().data).toEqual([]);
    expect(empty.json().meta.next_cursor).toBeNull();
    await collect(later, '2026-10-02T00:00:00Z');
    await db.updateTable('exoplanet').set({ removed_at: now }).where('name', '=', 'HD 2039 b').execute();
    for (const url of [historyUrl, '/v1/exoplanets/missing/revisions']) {
      const absent = await get(url);
      expect(absent.statusCode).toBe(404);
      expect(absent.headers['content-type']).toContain('application/problem+json');
      expect(absent.json().code).toBe('not_found');
    }
    expect((await get(`${historyUrl}?include_removed=true`)).json().data).toHaveLength(1);
  });

  it('rejects malformed, altered and differently bound cursors with stable problem errors', async () => {
    await collect(first, '2026-10-01T00:00:00Z');
    await collect(later, '2026-10-02T00:00:00Z');
    await collect(first, '2026-10-03T00:00:00Z');
    const cursor = (await get(`${historyUrl}?limit=1`)).json().meta.next_cursor as string;
    const tampered = `${cursor[0] === 'A' ? 'B' : 'A'}${cursor.slice(1)}`;
    for (const url of [
      `${historyUrl}?cursor=not-json`, `${historyUrl}?cursor=${Buffer.from('{}').toString('base64url')}`,
      `${historyUrl}?cursor=${tampered}`, `${historyUrl}?cursor=${cursor}&include_removed=true`,
      `/v1/exoplanets/HAT-P-8%20b/revisions?cursor=${cursor}`,
    ]) {
      const response = await get(url);
      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json().code).toBe('invalid_cursor');
    }
  });
  it('defaults to 50, accepts 200 and rejects invalid query input', async () => {
    await collect(first, '2026-10-01T00:00:00Z');
    const planet = await db.selectFrom('exoplanet').selectAll().where('name', '=', 'HD 2039 b').executeTakeFirstOrThrow();
    const { raw: _raw, content_hash: _hash, id: _id, first_seen_at: _first, last_seen_at: _last, removed_at: _removed, ...parameters } = planet;
    await db.insertInto('exoplanet_revision').values(Array.from({ length: 201 }, (_, index) => ({
      exoplanet_id: planet.id, parameters, content_hash: `revision-${index}`, recorded_at: now,
    }))).execute();
    expect((await get(historyUrl)).json().data).toHaveLength(50);
    expect((await get(`${historyUrl}?limit=200`)).json().data).toHaveLength(200);
    for (const query of ['limit=201', 'limit=0', 'limit=-1', 'limit=1.5', 'include_removed=perhaps']) {
      const response = await get(`${historyUrl}?${query}`);
      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json().code).toBe('invalid_input');
    }
  });

});
