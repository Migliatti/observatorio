import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import { buildApp } from '../api/app.js';
import { main } from '../collect/main.js';
import { createTestDatabase, resetDatabase, testDatabaseUrl } from './database.js';

describe('coleta and API together', () => {
  let db: Database;
  let app: FastifyInstance;
  const now = new Date('2026-10-12T12:00:00Z');
  beforeAll(async () => { db = createTestDatabase(); app = await buildApp({ db, now: () => now }); await app.ready(); });
  beforeEach(async () => { await resetDatabase(db); });
  afterAll(async () => { await app.close(); await db.destroy(); });
  it('serves recorded Archive data after a failed coleta, with honest frescor and no fonte request', async () => {
    const recorded = readFileSync(new URL('../sources/fixtures/exoplanet-archive/pscomppars.json', import.meta.url), 'utf8');
    const collected = new Date('2026-10-10T11:00:00Z');
    expect(await main(['exoplanet-archive'], { databaseUrl: testDatabaseUrl(), now: () => collected,
      http: { fetch: async () => new Response(recorded) }, log: () => {}, logError: () => {} })).toBe(0);
    expect(await main(['exoplanet-archive'], { databaseUrl: testDatabaseUrl(), now: () => now,
      http: { fetch: async () => new Response('Unavailable', { status: 503 }), sleep: async () => {} }, log: () => {}, logError: () => {} })).toBe(1);
    const response = await app.inject('/v1/exoplanets/HD%202039%20b');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ name: 'HD 2039 b', discovery_year: 2002, mass_earth_masses: 1999.1507 });
    expect(response.json().meta.sources[0]).toMatchObject({ data_as_of: '2026-10-10T11:00:00.000Z', stale: true });
  });

});
