import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Existing rows acquire their hash on the next coleta, without a spurious revision.
  await sql`alter table exoplanet add column content_hash text`.execute(db);
  await sql`
    create table exoplanet_revision (
      id bigint generated always as identity primary key,
      exoplanet_id bigint not null references exoplanet(id),
      parameters jsonb not null,
      content_hash text not null,
      recorded_at timestamptz not null
    )
  `.execute(db);
  await sql`create index exoplanet_revision_history_idx
    on exoplanet_revision (exoplanet_id, recorded_at, id)`.execute(db);
}
