// Stores a coleta of the Exoplanet Archive: upserts every exoplaneta seen and marks the missing ones as removed.
import { sql, type Transaction } from 'kysely';
import type { DB } from '../db/generated/database.js';
import { EXOPLANET_FIELDS, fetchExoplanetArchive, type ArchiveExoplanet } from '../sources/exoplanet-archive.js';
import type { HttpOptions } from '../sources/http.js';
import type { CollectionCounts, Collector } from './run.js';

// Postgres accepts at most 65535 parameters per statement; ~25 columns per row stays well below that.
const BATCH_SIZE = 1_000;

export function exoplanetArchiveCollector(http: HttpOptions = {}): Collector<ArchiveExoplanet[]> {
  return { fetch: () => fetchExoplanetArchive(http), store: storeExoplanets };
}

export async function storeExoplanets(
  trx: Transaction<DB>,
  planets: ArchiveExoplanet[],
  now: Date,
): Promise<CollectionCounts> {
  const existing = new Map(
    (await trx.selectFrom('exoplanet').select(['name', ...EXOPLANET_FIELDS]).execute()).map((row) => [row.name, row]),
  );

  let created = 0;
  let revised = 0;
  for (const planet of planets) {
    const previous = existing.get(planet.name);
    if (!previous) created++;
    else if (EXOPLANET_FIELDS.some((field) => previous[field] !== planet[field])) revised++;
  }

  for (let start = 0; start < planets.length; start += BATCH_SIZE) {
    const rows = planets.slice(start, start + BATCH_SIZE).map(({ raw, ...fields }) => ({
      ...fields,
      raw: JSON.stringify(raw),
      first_seen_at: now,
      last_seen_at: now,
      removed_at: null,
    }));
    await trx
      .insertInto('exoplanet')
      .values(rows)
      .onConflict((oc) =>
        oc.column('name').doUpdateSet((eb) => ({
          ...Object.fromEntries(EXOPLANET_FIELDS.map((field) => [field, eb.ref(`excluded.${field}`)])),
          raw: eb.ref('excluded.raw'),
          last_seen_at: eb.ref('excluded.last_seen_at'),
          // A planeta removido that comes back is no longer removed.
          removed_at: null,
        })),
      )
      .execute();
  }

  // Planetas removidos: kept, but marked. Those already marked keep their original removed_at.
  const seen = planets.map((planet) => planet.name);
  await trx
    .updateTable('exoplanet')
    .set({ removed_at: now })
    .where('removed_at', 'is', null)
    .where(sql<boolean>`name <> all(${seen}::text[])`)
    .execute();

  return { seen: planets.length, created, revised };
}
