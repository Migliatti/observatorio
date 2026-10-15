import { sql, type Kysely } from 'kysely';

/** Service roles are provisioned once per Postgres cluster; object grants are per database. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
    do $roles$
    begin
      if not exists (select from pg_roles where rolname = 'observatorio_migrator') then
        create role observatorio_migrator login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      else
        alter role observatorio_migrator with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      end if;
      if not exists (select from pg_roles where rolname = 'observatorio_collector') then
        create role observatorio_collector login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      else
        alter role observatorio_collector with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      end if;
      if not exists (select from pg_roles where rolname = 'observatorio_api') then
        create role observatorio_api login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      else
        alter role observatorio_api with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      end if;
      if not exists (select from pg_roles where rolname = 'observatorio_key_admin') then
        create role observatorio_key_admin login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      else
        alter role observatorio_key_admin with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      end if;
    end
    $roles$;

    do $migration_membership$
    begin
      if current_user <> 'observatorio_migrator' then
        execute format('grant observatorio_migrator to %I', current_user);
      end if;
    end
    $migration_membership$;

    revoke create on schema public from public;
    grant usage, create on schema public to observatorio_migrator;
    grant usage on schema public to observatorio_api, observatorio_collector;
    grant usage on schema public to observatorio_key_admin;

    grant select, insert, update, delete on table
      public.kysely_migration,
      public.kysely_migration_lock
    to observatorio_migrator;
    alter table public.ingestion_run owner to observatorio_migrator;
    alter table public.exoplanet owner to observatorio_migrator;
    alter table public.exoplanet_revision owner to observatorio_migrator;
    alter table public.exoplanet_catalogue owner to observatorio_migrator;
    alter table public.exoplanet_catalogue_item owner to observatorio_migrator;
    alter table public.asteroid owner to observatorio_migrator;
    alter table public.close_approach owner to observatorio_migrator;
    alter table public.api_key owner to observatorio_migrator;

    revoke all on all tables in schema public from observatorio_api, observatorio_collector, observatorio_key_admin, public;
    revoke all on all sequences in schema public from observatorio_api, observatorio_collector, observatorio_key_admin, public;

    grant select on table
      public.ingestion_run,
      public.exoplanet,
      public.exoplanet_revision,
      public.exoplanet_catalogue,
      public.exoplanet_catalogue_item,
      public.asteroid,
      public.close_approach,
      public.api_key
    to observatorio_api;
    grant update (last_used_at) on table public.api_key to observatorio_api;

    grant insert on table public.api_key to observatorio_key_admin;
    grant select (id, prefix, consumer, created_at, last_used_at, revoked_at)
      on table public.api_key to observatorio_key_admin;
    grant update (revoked_at) on table public.api_key to observatorio_key_admin;
    grant usage on sequence public.api_key_id_seq to observatorio_key_admin;

    grant select, insert, update, delete on table
      public.ingestion_run,
      public.exoplanet,
      public.exoplanet_revision,
      public.exoplanet_catalogue,
      public.exoplanet_catalogue_item,
      public.asteroid,
      public.close_approach
    to observatorio_collector;
    grant usage, select on sequence
      public.ingestion_run_id_seq,
      public.exoplanet_id_seq,
      public.exoplanet_revision_id_seq,
      public.exoplanet_catalogue_id_seq,
      public.asteroid_id_seq,
      public.close_approach_id_seq
    to observatorio_collector;

    alter default privileges for role observatorio_migrator in schema public
      grant select on tables to observatorio_api;
  `).execute(db);
}
