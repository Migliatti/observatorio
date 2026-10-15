import { sql, type Kysely } from 'kysely';

/** Service roles are provisioned once per Postgres cluster; object grants are per database. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
    do $roles$
    begin
      if not exists (select from pg_roles where rolname = 'migrator') then
        create role migrator login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      else
        alter role migrator with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      end if;
      if not exists (select from pg_roles where rolname = 'collector') then
        create role collector login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      else
        alter role collector with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      end if;
      if not exists (select from pg_roles where rolname = 'api') then
        create role api login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      else
        alter role api with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      end if;
      if not exists (select from pg_roles where rolname = 'key_admin') then
        create role key_admin login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      else
        alter role key_admin with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      end if;
    end
    $roles$;

    do $migration_membership$
    begin
      if current_user <> 'migrator' then
        execute format('grant migrator to %I', current_user);
      end if;
    end
    $migration_membership$;

    revoke create on schema public from public;
    grant usage, create on schema public to migrator;
    grant usage on schema public to api, collector;
    grant usage on schema public to key_admin;

    grant select, insert, update, delete on table
      public.kysely_migration,
      public.kysely_migration_lock
    to migrator;
    alter table public.ingestion_run owner to migrator;
    alter table public.exoplanet owner to migrator;
    alter table public.exoplanet_revision owner to migrator;
    alter table public.exoplanet_catalogue owner to migrator;
    alter table public.exoplanet_catalogue_item owner to migrator;
    alter table public.asteroid owner to migrator;
    alter table public.close_approach owner to migrator;
    alter table public.api_key owner to migrator;

    revoke all on all tables in schema public from api, collector, key_admin, public;
    revoke all on all sequences in schema public from api, collector, key_admin, public;

    grant select on table
      public.ingestion_run,
      public.exoplanet,
      public.exoplanet_revision,
      public.exoplanet_catalogue,
      public.exoplanet_catalogue_item,
      public.asteroid,
      public.close_approach,
      public.api_key
    to api;
    grant update (last_used_at) on table public.api_key to api;

    grant select, insert on table public.api_key to key_admin;
    grant update (revoked_at) on table public.api_key to key_admin;
    grant usage, select on sequence public.api_key_id_seq to key_admin;

    grant select, insert, update, delete on table
      public.ingestion_run,
      public.exoplanet,
      public.exoplanet_revision,
      public.exoplanet_catalogue,
      public.exoplanet_catalogue_item,
      public.asteroid,
      public.close_approach
    to collector;
    grant usage, select on sequence
      public.ingestion_run_id_seq,
      public.exoplanet_id_seq,
      public.exoplanet_revision_id_seq,
      public.exoplanet_catalogue_id_seq,
      public.asteroid_id_seq,
      public.close_approach_id_seq
    to collector;

    alter default privileges for role migrator in schema public
      grant select on tables to api;
  `).execute(db);
}
