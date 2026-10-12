import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/database.js';
import { createTestDatabase, resetDatabase, testDatabaseUrl } from '../test/database.js';
import { main } from './main.js';

const body = readFileSync(new URL('../sources/fixtures/neows/feed.json', import.meta.url), 'utf8');
const DAY_1 = new Date('2015-09-07T01:00:00Z');
const DAY_2 = new Date('2015-09-08T01:00:00Z');

async function collect(response: string, now: Date, status = 200) {
  const urls: string[] = [];
  const errors: string[] = [];
  const code = await main(['neows'], {
    databaseUrl: testDatabaseUrl(), nasaApiKey: 'fixture-key', now: () => now,
    http: { fetch: async (url) => { urls.push(String(url)); return new Response(response, { status }); }, sleep: async () => {} },
    log: () => {}, logError: (message) => errors.push(message),
  });
  return { code, urls, errors };
}


describe('coleta of NeoWs', () => {
  let db: Database;
  beforeAll(() => { db = createTestDatabase(); });
  beforeEach(async () => { await resetDatabase(db); });
  afterAll(async () => { await db.destroy(); });


  it('stores the real feed, rewrites future predictions and freezes past aproximações across a rolling window', async () => {
    const first = await collect(body, DAY_1);
    expect(first.code).toBe(0);
    expect(first.urls).toHaveLength(1);
    expect(new URL(first.urls[0]!).searchParams.get('end_date')).toBe('2015-09-13');
    const original = await db.selectFrom('close_approach').selectAll().orderBy('id').execute();
    expect(original).toHaveLength(21);
    const asteroids = await db.selectFrom('asteroid').selectAll().execute();
    expect(asteroids).toHaveLength(21);
    const pastId = asteroids.find((row) => row.jpl_id === '2440012')!.id;
    const futureId = asteroids.find((row) => row.jpl_id === '2465633')!.id;
    const past = original.find((row) => row.asteroid_id === pastId)!;
    const future = original.find((row) => row.asteroid_id === futureId)!;

    const later = JSON.parse(body);
    later.near_earth_objects['2015-09-07'][0].close_approach_data[0].miss_distance.kilometers = '1';
    later.near_earth_objects['2015-09-08'][0].close_approach_data[0].miss_distance.kilometers = '123';
    const newApproach = structuredClone(later.near_earth_objects['2015-09-08'][0]);
    newApproach.close_approach_data[0].epoch_date_close_approach = 1442188800000; // 2015-09-14 UTC
    later.near_earth_objects['2015-09-14'] = [newApproach];
    const second = await collect(JSON.stringify(later), DAY_2);
    expect(second.code).toBe(0);
    expect(new URL(second.urls[0]!).searchParams.get('start_date')).toBe('2015-09-08');
    expect(new URL(second.urls[0]!).searchParams.get('end_date')).toBe('2015-09-14');
    const stored = await db.selectFrom('close_approach').selectAll().orderBy('id').execute();
    expect(stored).toHaveLength(22);
    expect(stored.find((row) => row.id === past.id)).toEqual(past);
    expect(stored.find((row) => row.id === future.id)).toMatchObject({ miss_distance_km: 123, first_seen_at: DAY_1, last_seen_at: DAY_2 });
    expect(await db.selectFrom('asteroid').selectAll().execute()).toHaveLength(21);
    const runs = await db.selectFrom('ingestion_run').selectAll().orderBy('id').execute();
    expect(runs).toMatchObject([
      { status: 'succeeded', seen_count: 21, created_count: 21, revised_count: 0 },
      { status: 'succeeded', seen_count: 22, created_count: 1, revised_count: 1 },
    ]);
  });

  it('keeps the last good data and records failure after retrying temporary fonte errors', async () => {
    expect((await collect(body, DAY_1)).code).toBe(0);
    const previous = await db.selectFrom('close_approach').selectAll().orderBy('id').execute();
    const failed = await collect('temporarily unavailable', DAY_2, 503);
    expect(failed.code).toBe(1);
    expect(failed.urls).toHaveLength(3);
    expect(await db.selectFrom('close_approach').selectAll().orderBy('id').execute()).toEqual(previous);
    expect((await db.selectFrom('ingestion_run').selectAll().orderBy('id').execute()).at(-1)).toMatchObject({ status: 'failed', error: expect.stringContaining('HTTP 503') });
  });

  it('requires NASA configuration only for the NeoWs collection CLI', async () => {
    const errors: string[] = [];
    expect(await main(['neows'], { databaseUrl: testDatabaseUrl(), logError: (message) => errors.push(message) })).toBe(1);
    expect(errors).toEqual(['NASA_API_KEY is missing. See .env.example.']);
    expect(await db.selectFrom('ingestion_run').selectAll().execute()).toEqual([]);
  });
});
