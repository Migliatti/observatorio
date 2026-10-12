import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table exoplanet_catalogue (
      id bigint generated always as identity primary key,
      cursor_key text not null default (gen_random_uuid()::text || gen_random_uuid()::text),
      ingestion_run_id bigint unique references ingestion_run(id),
      data_as_of timestamptz,
      created_at timestamptz not null,
      expires_at timestamptz
    )
  `.execute(db);
  // LIKE keeps the typed columns and NOT NULL constraints, but copies neither identity nor indexes.
  await sql`create table exoplanet_catalogue_item (like exoplanet)`.execute(db);
  await sql`
    alter table exoplanet_catalogue_item
      drop column raw,
      drop column content_hash,
      add column catalogue_id bigint not null references exoplanet_catalogue(id) on delete cascade,
      add primary key (catalogue_id, id)
  `.execute(db);
  for (const column of ['name', 'discovery_year', 'radius_earth_radii', 'mass_earth_masses']) {
    await sql`create index ${sql.id(`exoplanet_catalogue_item_${column}_id_idx`)}
      on exoplanet_catalogue_item (catalogue_id, ${sql.id(column)}, id)`.execute(db);
  }
  // Seed the pre-upgrade catalogue so deployment needs no immediate NASA request or API writes.
  await sql`
    with latest_run as (
      select id, finished_at from ingestion_run
      where source = 'exoplanet-archive' and status = 'succeeded' and finished_at is not null
      order by finished_at desc, id desc limit 1
    ), catalogue as (
      insert into exoplanet_catalogue (ingestion_run_id, data_as_of, created_at)
      select latest_run.id, latest_run.finished_at, now()
      from (values (1)) as seed(n) left join latest_run on true
      returning id
    )
    insert into exoplanet_catalogue_item
    select (jsonb_populate_record(null::exoplanet_catalogue_item,
      (to_jsonb(e) - 'raw' - 'content_hash') || jsonb_build_object('catalogue_id', c.id))).*
    from exoplanet e cross join catalogue c
  `.execute(db);
}
