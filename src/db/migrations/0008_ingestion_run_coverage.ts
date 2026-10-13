import { sql, type Kysely } from 'kysely';

/** Additive: older coletas retain null coverage; API falls back to their stored approaches. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table ingestion_run
    add column coverage_from date,
    add column coverage_to date,
    add constraint ingestion_run_coverage_check check (
      (coverage_from is null and coverage_to is null) or
      (coverage_from is not null and coverage_to is not null and coverage_from <= coverage_to)
    )`.execute(db);
}
