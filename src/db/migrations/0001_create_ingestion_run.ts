import { sql, type Kysely } from 'kysely';

// Coleta: uma execução que busca dados de uma fonte e os grava,
// registrada com início, fim, resultado e contagens.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table ingestion_run (
      id bigint generated always as identity primary key,
      source text not null,
      started_at timestamptz not null default now(),
      finished_at timestamptz,
      status text not null default 'running'
        check (status in ('running', 'succeeded', 'failed')),
      seen_count integer,
      created_count integer,
      revised_count integer,
      error text
    )
  `.execute(db);
}
