import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import { up as createRuns } from '../db/migrations/0001_create_ingestion_run.js';
import { up as createExoplanets } from '../db/migrations/0002_create_exoplanet.js';
import { up as createRevisions } from '../db/migrations/0003_create_exoplanet_revision.js';
import { up as createCatalogues } from '../db/migrations/0006_create_exoplanet_catalogue.js';
import { createTestDatabase } from './database.js';

let db: Database;
beforeAll(() => { db = createTestDatabase(); });
afterAll(async () => { await db.destroy(); });

it('upgrades existing data into a readable catalogue without a new coleta', async () => {
  await db.transaction().execute(async (trx) => {
    await sql`create schema catalogue_upgrade_test`.execute(trx);
    await sql`set local search_path to catalogue_upgrade_test`.execute(trx);
    // This schema starts at the pre-upgrade shape, before the current generated types apply.
    const migrationDb = trx as unknown as Kysely<unknown>;
    await createRuns(migrationDb);
    await createExoplanets(migrationDb);
    await createRevisions(migrationDb);
    await sql`insert into ingestion_run (source, status, finished_at)
      values ('exoplanet-archive', 'succeeded', '2026-10-10T12:00:00Z')`.execute(trx);
    await sql`insert into exoplanet (name, mass_earth_masses, raw, first_seen_at, last_seen_at)
      values ('Existing b', 2.5, '{"private":true}', '2026-10-10T12:00:00Z', '2026-10-10T12:00:00Z')`.execute(trx);
    await createCatalogues(migrationDb);
    const catalogue = await trx.selectFrom('exoplanet_catalogue').selectAll().executeTakeFirstOrThrow();
    expect(catalogue).toMatchObject({ ingestion_run_id: '1', data_as_of: new Date('2026-10-10T12:00:00Z'), expires_at: null });
    const row = await trx.selectFrom('exoplanet_catalogue_item').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ id: '1', catalogue_id: catalogue.id, name: 'Existing b', mass_earth_masses: 2.5 });
    expect(row).not.toHaveProperty('raw');
    expect(row).not.toHaveProperty('content_hash');
    await sql`drop schema catalogue_upgrade_test cascade`.execute(trx);
  });
});
