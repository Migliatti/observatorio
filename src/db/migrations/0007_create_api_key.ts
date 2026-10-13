import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table api_key (
      id bigint generated always as identity primary key,
      key_hash text not null unique check (key_hash ~ '^[a-f0-9]{64}$'),
      prefix text not null,
      consumer text not null check (length(trim(consumer)) > 0),
      created_at timestamptz not null default now(),
      revoked_at timestamptz,
      last_used_at timestamptz
    )
  `.execute(db);
}
