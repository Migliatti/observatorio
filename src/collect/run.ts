// Runs one coleta: per-fonte advisory lock, an ingestion_run row, and a single data transaction.
import { sql, type Transaction } from 'kysely';
import type { Database } from '../db/database.js';
import type { DB } from '../db/generated/database.js';
import type { Source } from '../domain/source.js';

export interface CollectionCounts {
  seen: number;
  created: number;
  revised: number;
}

export interface CollectionResult extends CollectionCounts {
  runId: string;
}

export interface Collector<T> {
  /** Reads the fonte. Runs before the data transaction, so no transaction stays open during network I/O. */
  fetch: () => Promise<T>;
  /** Writes what was read. Runs inside the data transaction; any error rolls everything back. */
  store: (trx: Transaction<DB>, data: T, now: Date) => Promise<CollectionCounts>;
  /** Publishes read versions after the success metadata, in the same data transaction. */
  publish?: (trx: Transaction<DB>, runId: string, finishedAt: Date) => Promise<void>;
}

/** Another coleta of the same fonte holds the lock. */
export class CollectionLockedError extends Error {
  constructor(source: Source) {
    super(`Another coleta of "${source}" is already running`);
    this.name = 'CollectionLockedError';
  }
}

/**
 * Runs a coleta of `source`. Uses one dedicated connection for the whole run, because a session-level
 * pg_advisory_lock belongs to the connection that took it (so DATABASE_URL must be the direct endpoint,
 * never a transaction pooler). The ingestion_run row is written outside the data transaction, so a
 * failed run is recorded even though its data is rolled back.
 */
export async function runCollection<T>(
  db: Database,
  source: Source,
  collector: Collector<T>,
  now: () => Date = () => new Date(),
): Promise<CollectionResult> {
  return db.connection().execute(async (conn) => {
    const lockKey = `coleta:${source}`;
    const { rows } = await sql<{ locked: boolean }>`
      select pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) as locked
    `.execute(conn);
    if (!rows[0]?.locked) throw new CollectionLockedError(source);

    try {
      const run = await conn
        .insertInto('ingestion_run')
        .values({ source, started_at: now(), status: 'running' })
        .returning('id')
        .executeTakeFirstOrThrow();

      try {
        const data = await collector.fetch();
        const counts = await conn.transaction().execute(async (trx) => {
          const stored = await collector.store(trx, data, now());
          const finishedAt = now();
          // Data and success metadata must commit together, so a failed run keeps the last good data.
          await trx
            .updateTable('ingestion_run')
            .set({
              status: 'succeeded',
              finished_at: finishedAt,
              seen_count: stored.seen,
              created_count: stored.created,
              revised_count: stored.revised,
            })
            .where('id', '=', run.id)
            .execute();
          await collector.publish?.(trx, run.id, finishedAt);
          return stored;
        });
        return { runId: run.id, ...counts };
      } catch (error) {
        await conn
          .updateTable('ingestion_run')
          .set({ status: 'failed', finished_at: now(), error: describeError(error) })
          .where('id', '=', run.id)
          .execute()
          .catch((recordError: unknown) => {
            console.error('Could not record the failed coleta:', recordError);
          });
        throw error;
      }
    } finally {
      // If the connection is gone, the server already released the lock with the session.
      await sql`select pg_advisory_unlock(hashtextextended(${lockKey}, 0))`.execute(conn).catch((unlockError: unknown) => {
        console.error('Could not release the coleta lock:', unlockError);
      });
    }
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
