import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table asteroid (
      id bigint generated always as identity primary key,
      jpl_id text not null unique,
      name text not null,
      absolute_magnitude_h double precision,
      estimated_diameter_min_km double precision,
      estimated_diameter_max_km double precision,
      is_potentially_hazardous boolean not null,
      raw jsonb not null,
      first_seen_at timestamptz not null,
      last_seen_at timestamptz not null
    )
  `.execute(db);
  await sql`
    create table close_approach (
      id bigint generated always as identity primary key,
      asteroid_id bigint not null references asteroid(id),
      date date not null,
      approach_at timestamptz not null,
      miss_distance_km double precision,
      relative_velocity_kms double precision,
      orbiting_body text,
      raw jsonb not null,
      first_seen_at timestamptz not null,
      last_seen_at timestamptz not null,
      unique (asteroid_id, date)
    )
  `.execute(db);
  await sql`create index close_approach_date_idx on close_approach (date)`.execute(db);
}
