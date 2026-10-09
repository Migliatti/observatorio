// Coleta of the Exoplanet Archive against the real Postgres, with the fonte served from recorded fixtures.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/database.js';
import type { Fetch } from '../sources/http.js';
import { createTestDatabase, resetDatabase, testDatabaseUrl } from '../test/database.js';
import { exoplanetArchiveCollector, storeExoplanets } from './exoplanet-archive.js';
import { main } from './main.js';
import { CollectionLockedError, runCollection } from './run.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../sources/fixtures/exoplanet-archive/${name}`, import.meta.url), 'utf8');

const DAY_1 = new Date('2026-10-01T03:00:00Z');
const DAY_2 = new Date('2026-10-02T03:00:00Z');
const DAY_3 = new Date('2026-10-03T03:00:00Z');

/** A fetch that always answers with the given body and status, counting calls. */
function serve(body: string, status = 200): Fetch {
  return async () => new Response(body, { status });
}

const noSleep = async () => {};

async function collect(body: string, now: Date, status = 200) {
  const errors: string[] = [];
  const code = await main(['exoplanet-archive'], {
    databaseUrl: testDatabaseUrl(),
    http: { fetch: serve(body, status), sleep: noSleep },
    now: () => now,
    log: () => {},
    logError: (message) => errors.push(message),
  });
  return { code, errors };
}

describe('coleta of the Exoplanet Archive', () => {
  let db: Database;

  beforeAll(() => {
    db = createTestDatabase();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  const planets = () =>
    db.selectFrom('exoplanet').selectAll().orderBy('name').execute();
  const runs = () =>
    db.selectFrom('ingestion_run').selectAll().orderBy('id').execute();

  it('stores every exoplaneta and records a successful run', async () => {
    const { code } = await collect(fixture('pscomppars.json'), DAY_1);
    expect(code).toBe(0);

    const stored = await planets();
    expect(stored).toHaveLength(5);
    const hatP8 = stored.find((planet) => planet.name === 'HAT-P-8 b')!;
    expect(hatP8).toMatchObject({
      host_name: 'HAT-P-8',
      discovery_year: 2008,
      radius_earth_radii: 15.6926,
      mass_earth_masses: 406.8224,
      first_seen_at: DAY_1,
      last_seen_at: DAY_1,
      removed_at: null,
    });
    expect(hatP8.raw).toMatchObject({ pl_name: 'HAT-P-8 b', hostname: 'HAT-P-8' });
    expect(stored.find((planet) => planet.name === 'AB Pic b')!.orbital_period_days).toBeNull();

    expect(await runs()).toEqual([
      expect.objectContaining({
        source: 'exoplanet-archive',
        status: 'succeeded',
        started_at: DAY_1,
        finished_at: DAY_1,
        seen_count: 5,
        created_count: 5,
        revised_count: 0,
        error: null,
      }),
    ]);
  });

  it('marks a planeta removido, keeps it, and clears the mark when it reappears', async () => {
    await collect(fixture('pscomppars.json'), DAY_1);

    expect((await collect(fixture('pscomppars-later.json'), DAY_2)).code).toBe(0);
    let stored = await planets();
    expect(stored).toHaveLength(5);
    expect(stored.find((planet) => planet.name === 'K2-43 b')).toMatchObject({
      removed_at: DAY_2,
      last_seen_at: DAY_1,
    });
    const hd2039 = stored.find((planet) => planet.name === 'HD 2039 b')!;
    expect(hd2039).toMatchObject({ mass_earth_masses: 2010, first_seen_at: DAY_1, last_seen_at: DAY_2, removed_at: null });
    expect((await runs()).at(-1)).toMatchObject({ seen_count: 4, created_count: 0, revised_count: 1 });

    expect((await collect(fixture('pscomppars.json'), DAY_3)).code).toBe(0);
    stored = await planets();
    expect(stored.find((planet) => planet.name === 'K2-43 b')).toMatchObject({
      removed_at: null,
      first_seen_at: DAY_1,
      last_seen_at: DAY_3,
    });
    expect((await runs()).at(-1)).toMatchObject({ seen_count: 5, created_count: 0, revised_count: 1 });
  });

  it('fails on an Archive error sent as HTTP 200, keeping the previous data', async () => {
    await collect(fixture('pscomppars.json'), DAY_1);

    const { code, errors } = await collect(fixture('error-http-200.xml'), DAY_2);
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/invalid identifier/);

    const stored = await planets();
    expect(stored).toHaveLength(5);
    expect(stored.every((planet) => planet.removed_at === null && planet.last_seen_at.getTime() === DAY_1.getTime())).toBe(true);
    expect((await runs()).at(-1)).toMatchObject({
      status: 'failed',
      finished_at: DAY_2,
      seen_count: null,
      error: expect.stringContaining('ArchiveResponseError'),
    });
  });

  it('fails when the fonte keeps answering with server errors', async () => {
    const { code } = await collect('unavailable', DAY_1, 503);
    expect(code).toBe(1);
    expect(await runs()).toEqual([expect.objectContaining({ status: 'failed', error: expect.stringContaining('HTTP 503') })]);
  });

  it('rolls back the whole coleta when it fails midway, but still records the failed run', async () => {
    const collector = exoplanetArchiveCollector({ fetch: serve(fixture('pscomppars.json')) });
    const failing = {
      ...collector,
      store: async (...args: Parameters<typeof storeExoplanets>) => {
        await storeExoplanets(...args);
        throw new Error('disk full');
      },
    };

    await expect(runCollection(db, 'exoplanet-archive', failing, () => DAY_1)).rejects.toThrow('disk full');

    expect(await planets()).toEqual([]);
    expect(await runs()).toEqual([
      expect.objectContaining({ status: 'failed', error: 'Error: disk full', finished_at: DAY_1 }),
    ]);
  });

  it('refuses a second coleta of the same fonte while one is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => (started = resolve));
    const slow = {
      ...exoplanetArchiveCollector(),
      fetch: async () => {
        started();
        await gate;
        return exoplanetArchiveCollector({ fetch: serve(fixture('pscomppars.json')) }).fetch();
      },
    };

    const first = runCollection(db, 'exoplanet-archive', slow, () => DAY_1);
    await fetching;

    const second = await collect(fixture('pscomppars.json'), DAY_1);
    expect(second.code).toBe(1);
    expect(second.errors.join('\n')).toMatch(/already running/);
    await expect(
      runCollection(db, 'exoplanet-archive', exoplanetArchiveCollector(), () => DAY_1),
    ).rejects.toBeInstanceOf(CollectionLockedError);

    release();
    await expect(first).resolves.toMatchObject({ seen: 5, created: 5 });
    // The refused coletas never started, so only the first one is recorded.
    expect(await runs()).toEqual([expect.objectContaining({ status: 'succeeded' })]);

    // Once released, the lock can be taken again.
    expect((await collect(fixture('pscomppars.json'), DAY_2)).code).toBe(0);
  });

  it('exits with an error for an unknown fonte', async () => {
    const errors: string[] = [];
    const code = await main(['mars'], { databaseUrl: testDatabaseUrl(), logError: (m) => errors.push(m) });
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/Known sources: exoplanet-archive, neows/);
  });
});
