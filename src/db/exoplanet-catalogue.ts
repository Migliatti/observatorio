import { sql, type Transaction } from 'kysely';
import { EXOPLANET_PARAMETER_FIELDS } from '../domain/exoplanet.js';
import type { DB } from './generated/database.js';

export const EXOPLANET_CATALOG_FIELDS = ['id', ...EXOPLANET_PARAMETER_FIELDS, 'first_seen_at', 'last_seen_at', 'removed_at'] as const;
export const CATALOGUE_RETENTION_MS = 48 * 60 * 60 * 1000;
export const EXOPLANET_CATALOGUE_LOCK = 'catalogue:exoplanet-archive';

/** Publishes an immutable catalogue in the same transaction as the successful coleta. */
export async function publishExoplanetCatalogue(trx: Transaction<DB>, runId: string, finishedAt: Date): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${EXOPLANET_CATALOGUE_LOCK}, 0))`.execute(trx);
  // Only superseded catalogues expire. The latest one remains available through fonte outages.
  await trx.updateTable('exoplanet_catalogue').set({ expires_at: new Date(finishedAt.getTime() + CATALOGUE_RETENTION_MS) })
    .where('expires_at', 'is', null).execute();
  const catalogue = await trx.insertInto('exoplanet_catalogue')
    .values({ ingestion_run_id: runId, data_as_of: finishedAt, created_at: finishedAt })
    .returning('id').executeTakeFirstOrThrow();
  await trx.insertInto('exoplanet_catalogue_item').columns(['catalogue_id', ...EXOPLANET_CATALOG_FIELDS])
    .expression(trx.selectFrom('exoplanet').select([sql<string>`${catalogue.id}::bigint`.as('catalogue_id'), ...EXOPLANET_CATALOG_FIELDS]))
    .execute();
  // The foreign key cascades to catalogue items; permanent exoplaneta/revision history is untouched.
  await trx.deleteFrom('exoplanet_catalogue').where('expires_at', '<=', finishedAt).execute();
}
