import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/database.js';
import { parseExoplanetArchive } from '../sources/exoplanet-archive.js';
import { createTestDatabase, resetDatabase } from '../test/database.js';
import { exoplanetArchiveCollector, storeExoplanets } from './exoplanet-archive.js';
import { runCollection } from './run.js';

const fixture = (name: string) => readFileSync(new URL(`../sources/fixtures/exoplanet-archive/${name}`, import.meta.url), 'utf8');
const FIRST = fixture('pscomppars.json');
const LATER = fixture('pscomppars-later.json');
const DAY_1 = new Date('2026-10-01T03:00:00Z');
const DAY_2 = new Date('2026-10-02T03:00:00Z');
const DAY_3 = new Date('2026-10-03T03:00:00Z');
const collector = (body: string) => exoplanetArchiveCollector({ fetch: async () => new Response(body) });

describe('revisions across coletas of the Exoplanet Archive', () => {
  let db: Database;
  beforeAll(() => { db = createTestDatabase(); });
  beforeEach(async () => { await resetDatabase(db); });
  afterAll(async () => { await db.destroy(); });

  const collect = (body: string, now: Date) => runCollection(db, 'exoplanet-archive', collector(body), () => now);
  const revisions = () => db.selectFrom('exoplanet_revision').selectAll().orderBy('id').execute();

  it('appends the previous typed parameters only when a release changes their hash', async () => {
    await collect(FIRST, DAY_1);
    expect(await revisions()).toEqual([]);
    const previous = await db.selectFrom('exoplanet').selectAll().where('name', '=', 'HD 2039 b').executeTakeFirstOrThrow();

    expect(await collect(LATER, DAY_2)).toMatchObject({ revised: 1 });
    const { raw: _raw, ...expectedParameters } = parseExoplanetArchive(FIRST).find((planet) => planet.name === 'HD 2039 b')!;
    const history = await revisions();
    expect(history).toEqual([expect.objectContaining({
      exoplanet_id: previous.id,
      content_hash: previous.content_hash,
      parameters: expectedParameters,
      recorded_at: DAY_2,
    })]);
    const current = await db.selectFrom('exoplanet').select(['mass_earth_masses', 'content_hash']).where('id', '=', previous.id).executeTakeFirstOrThrow();
    expect(current.mass_earth_masses).toBe(2010);
    expect(current.content_hash).not.toBe(previous.content_hash);

    expect(await collect(LATER, DAY_3)).toMatchObject({ revised: 0 });
    expect(await revisions()).toEqual(history);
    expect(await collect(FIRST, DAY_3)).toMatchObject({ revised: 1 });
    expect(await revisions()).toHaveLength(2);
    expect((await revisions())[0]).toEqual(history[0]);
    expect((await revisions())[1]!.parameters).toMatchObject({ name: 'HD 2039 b', mass_earth_masses: 2010 });
  });

  it('backfills legacy hashes without a revision and still detects a later changed parameter', async () => {
    await collect(FIRST, DAY_1);
    await db.updateTable('exoplanet').set({ content_hash: null }).execute();
    expect(await collect(FIRST, DAY_2)).toMatchObject({ revised: 0 });
    expect(await revisions()).toEqual([]);
    const hashes = await db.selectFrom('exoplanet').select('content_hash').execute();
    expect(hashes.every((row) => /^[a-f0-9]{64}$/.test(row.content_hash!))).toBe(true);
    await db.updateTable('exoplanet').set({ content_hash: null }).execute();
    expect(await collect(LATER, DAY_3)).toMatchObject({ revised: 1 });
    expect(await revisions()).toHaveLength(1);
  });

  it('rolls back revisions and replacement parameters together when the coleta fails', async () => {
    await collect(FIRST, DAY_1);
    const before = await db.selectFrom('exoplanet').selectAll().orderBy('id').execute();
    const failing = {
      ...collector(LATER),
      store: async (...args: Parameters<typeof storeExoplanets>) => {
        await storeExoplanets(...args);
        throw new Error('coleta interrupted');
      },
    };
    await expect(runCollection(db, 'exoplanet-archive', failing, () => DAY_2)).rejects.toThrow('coleta interrupted');
    expect(await revisions()).toEqual([]);
    expect(await db.selectFrom('exoplanet').selectAll().orderBy('id').execute()).toEqual(before);
  });
});
