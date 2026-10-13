import { createApiKey } from '../db/api-key.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Insertable } from 'kysely';
import type { Exoplanet } from '../db/generated/database.js';
import type { Database } from '../db/database.js';
import { createTestDatabase, resetDatabase } from '../test/database.js';
import { buildApp } from './app.js';
import { publishExoplanetCatalogue } from '../db/exoplanet-catalogue.js';

const names = (response: { json(): { data: Array<{ name: string }> } }) => response.json().data.map((row) => row.name);

describe('exoplanetas por HTTP', () => {
  let db: Database;
  let app: FastifyInstance;
  let authorization: string;
  const request = (url: string) => app.inject({ url, headers: { authorization } });
  const now = new Date('2026-10-12T12:00:00Z');
  beforeAll(async () => { db = createTestDatabase(); app = await buildApp({ db, now: () => now }); await app.ready(); });
  beforeEach(async () => { await resetDatabase(db); authorization = `Bearer ${(await createApiKey(db, 'test consumer', now)).key}`; });
  afterAll(async () => { await app.close(); await db.destroy(); });
  const publishVersion = async (finishedAt = now) => db.transaction().execute(async (trx) => {
    const run = await trx.insertInto('ingestion_run').values({ source: 'exoplanet-archive', status: 'succeeded', finished_at: finishedAt })
      .returning('id').executeTakeFirstOrThrow();
    await publishExoplanetCatalogue(trx, run.id, finishedAt);
  });
  const seed = async (rows: Array<Partial<Insertable<Exoplanet>> & { name: string }>) => {
    await db.insertInto('exoplanet').values(rows.map((row) => ({ raw: {}, first_seen_at: now, last_seen_at: now, ...row }))).execute();
    await publishVersion();
  };
  it('lists typed data with the last successful coleta and required Archive credit', async () => {
    await db.insertInto('exoplanet').values({ name: 'Kepler-1 b', raw: { secret: true }, first_seen_at: now, last_seen_at: now }).execute();
    await publishVersion(new Date('2026-10-10T11:59:59Z'));
    const response = await request('/v1/exoplanets');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ name: 'Kepler-1 b', radius_earth_radii: null, removed_at: null });
    expect(body.data[0]).not.toHaveProperty('raw');
    expect(body.data[0]).not.toHaveProperty('content_hash');
    expect(body.meta.sources[0]).toMatchObject({ name: 'exoplanet-archive', data_as_of: '2026-10-10T11:59:59.000Z', stale: true });
    expect(body.meta.sources[0].attribution).toContain('Christiansen et al. (2025)');
    expect(body.meta.sources[0].attribution).toContain('This research has made use of the NASA Exoplanet Archive');
    expect(body.meta.next_cursor).toBeNull();
  });
  it('filters literal name substrings, host, method, year, radius and mass ranges', async () => {
    await seed([
      { name: 'Kepler-1 b', host_name: 'Kepler-1', discovery_method: 'Transit', discovery_year: 2009, radius_earth_radii: 2, mass_earth_masses: 5 },
      { name: 'Kepler-2 b', host_name: 'Kepler-2', discovery_method: 'Imaging', discovery_year: 2010, radius_earth_radii: 4, mass_earth_masses: 10 },
      { name: 'A%_ b', host_name: 'Other', discovery_method: 'Transit', discovery_year: 2011, radius_earth_radii: 8, mass_earth_masses: 20 },
      { name: 'Unknown b' },
    ]);
    for (const filter of ['name=ler-1', 'host_name=Kepler-1', 'discovery_year_max=2009', 'radius_earth_radii_max=2', 'mass_earth_masses_max=5']) {
      expect(names(await request(`/v1/exoplanets?${filter}`))).toEqual(['Kepler-1 b']);
    }
    for (const filter of ['discovery_year_min=2011', 'radius_earth_radii_min=8', 'mass_earth_masses_min=20', 'name=%25_']) {
      expect(names(await request(`/v1/exoplanets?${filter}`))).toEqual(['A%_ b']);
    }
    expect(names(await request('/v1/exoplanets?discovery_method=Transit'))).toEqual(['A%_ b', 'Kepler-1 b']);
    expect(names(await request('/v1/exoplanets?discovery_year_min=2010&discovery_year_max=2010&radius_earth_radii_min=4&radius_earth_radii_max=4&mass_earth_masses_min=10&mass_earth_masses_max=10'))).toEqual(['Kepler-2 b']);
  });
  it.each(['name', 'discovery_year', 'radius_earth_radii', 'mass_earth_masses'] as const)('sorts %s in both directions with null values last and stable ties', async (sort) => {
    await seed([
      { name: 'B b', discovery_year: 2010, radius_earth_radii: 2, mass_earth_masses: 2 },
      { name: 'A b', discovery_year: 2000, radius_earth_radii: 1, mass_earth_masses: 1 },
      { name: 'C b', discovery_year: 2010, radius_earth_radii: 2, mass_earth_masses: 2 },
      { name: 'D b' },
    ]);
    expect(names(await request(`/v1/exoplanets?sort=${sort}&order=asc`))).toEqual(['A b', 'B b', 'C b', 'D b']);
    expect(names(await request(`/v1/exoplanets?sort=${sort}&order=desc`))).toEqual(sort === 'name' ? ['D b', 'C b', 'B b', 'A b'] : ['C b', 'B b', 'A b', 'D b']);
  });
  it.each(['asc', 'desc'] as const)('paginates equal and null values without repeating in %s order', async (order) => {
    await seed([
      { name: 'A b', radius_earth_radii: 1 }, { name: 'B b', radius_earth_radii: 1 },
      { name: 'C b', radius_earth_radii: 2 }, { name: 'D b' }, { name: 'E b' },
    ]);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const pageUrl: string = `/v1/exoplanets?sort=radius_earth_radii&order=${order}&limit=1${cursor ? `&cursor=${cursor}` : ''}`;
      const response = await request(pageUrl);
      expect(response.statusCode).toBe(200);
      seen.push(...names(response));
      cursor = response.json().meta.next_cursor;
    } while (cursor);
    expect(seen).toEqual(order === 'asc' ? ['A b', 'B b', 'C b', 'D b', 'E b'] : ['C b', 'B b', 'A b', 'E b', 'D b']);
  });
  it('keeps page anchors valid after their removal and excludes newly inserted records', async () => {
    await seed([{ name: 'A b' }, { name: 'B b' }, { name: 'C b' }]);
    const first = await request('/v1/exoplanets?limit=1');
    const cursor = first.json().meta.next_cursor;
    await db.updateTable('exoplanet').set({ removed_at: now }).where('name', '=', 'A b').execute();
    await seed([{ name: 'AA b' }]);
    const second = await request(`/v1/exoplanets?limit=2&cursor=${cursor}`);
    expect(names(second)).toEqual(['B b', 'C b']);
    expect(second.json().meta.next_cursor).toBeNull();
  });
  it('continues the original catalogue when a successful coleta changes the catalogue', async () => {
    await seed([{ name: 'A b', radius_earth_radii: 1 }, { name: 'B b', radius_earth_radii: 2 }]);
    const first = await request('/v1/exoplanets?sort=radius_earth_radii&limit=1');
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('exoplanet').set({ radius_earth_radii: 5 }).where('name', '=', 'A b').execute();
      const run = await trx.insertInto('ingestion_run').values({ source: 'exoplanet-archive', status: 'succeeded', finished_at: now }).returning('id').executeTakeFirstOrThrow();
      await publishExoplanetCatalogue(trx, run.id, now);
    });
    const response = await request(`/v1/exoplanets?sort=radius_earth_radii&limit=1&cursor=${first.json().meta.next_cursor}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([expect.objectContaining({ name: 'B b', radius_earth_radii: 2 })]);
    expect(response.json().meta.updates_available).toBe(true);
  });
  it('rejects malformed cursors and cursors used with different filters or sorting', async () => {
    await seed([{ name: 'A b' }, { name: 'B b' }]);
    const first = await request('/v1/exoplanets?limit=1');
    const cursor = first.json().meta.next_cursor;
    for (const query of ['cursor=not-json', `cursor=${Buffer.from('{}').toString('base64url')}`, `cursor=${cursor}&sort=discovery_year`, `cursor=${cursor}&order=desc`, `cursor=${cursor}&name=B`, `cursor=${cursor}&include_removed=true`]) {
      const response = await request(`/v1/exoplanets?${query}`);
      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json().code).toBe('invalid_cursor');
    }
  });
  it('uses URL-encoded Archive names and hides removed exoplanetas unless explicitly included', async () => {
    await seed([{ name: 'HD 1 / b', removed_at: now }, { name: 'Active b' }]);
    expect(names(await request('/v1/exoplanets'))).toEqual(['Active b']);
    expect(names(await request('/v1/exoplanets?include_removed=true'))).toEqual(['Active b', 'HD 1 / b']);
    const url = `/v1/exoplanets/${encodeURIComponent('HD 1 / b')}`;
    const absent = await request(url);
    expect(absent.statusCode).toBe(404);
    expect(absent.headers['content-type']).toContain('application/problem+json');
    expect(absent.json().code).toBe('not_found');
    const included = await request(`${url}?include_removed=true`);
    expect(included.statusCode).toBe(200);
    expect(included.json().data).toMatchObject({ name: 'HD 1 / b', removed_at: '2026-10-12T12:00:00.000Z' });
    expect((await request('/v1/exoplanets/missing')).json().code).toBe('not_found');
  });
  it('defaults to 50 items, accepts 200 and rejects invalid input consistently', async () => {
    await seed(Array.from({ length: 201 }, (_, index) => ({ name: `Exoplanet ${String(index).padStart(3, '0')} b` })));
    expect((await request('/v1/exoplanets')).json().data).toHaveLength(50);
    expect((await request('/v1/exoplanets?limit=200')).json().data).toHaveLength(200);
    for (const query of ['limit=201', 'limit=0', 'limit=1.5', 'sort=raw', 'order=sideways', 'include_removed=perhaps', 'discovery_year_min=2010&discovery_year_max=2000', 'radius_earth_radii_min=-1', 'mass_earth_masses_min=10&mass_earth_masses_max=1']) {
      const response = await request(`/v1/exoplanets?${query}`);
      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json().code).toBe('invalid_input');
    }
  });


});
