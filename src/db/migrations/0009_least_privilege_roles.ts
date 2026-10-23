import { sql, type Kysely } from 'kysely';

/** Service roles are provisioned once per Postgres cluster; object grants are per database. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
    do $migration_preflight$
    declare can_create_roles boolean;
    connection_is_superuser boolean;
    existing_role text;
    begin
      select rolcreaterole or rolsuper, rolsuper into can_create_roles, connection_is_superuser
      from pg_roles where rolname = current_user;
      if not coalesce(can_create_roles, false) then
        raise exception 'Migration 0009 requires a direct owner connection with CREATEROLE; use the bootstrap URL.';
      end if;

      if not coalesce(connection_is_superuser, false) then
        foreach existing_role in array array[
          'observatorio_migrator',
          'observatorio_collector',
          'observatorio_api',
          'observatorio_key_admin'
        ] loop
          if exists (
            select from pg_roles target
            where target.rolname = existing_role
              and target.rolsuper
          ) then
            raise exception 'Migration 0009 cannot alter pre-existing SUPERUSER role "%" as a non-superuser; run with a superuser connection or have an administrator correct the role first.', existing_role;
          end if;

          if exists (
            select from pg_roles target
            where target.rolname = existing_role
              and (target.rolbypassrls or target.rolreplication)
          ) then
            raise exception 'Migration 0009 cannot alter pre-existing BYPASSRLS or REPLICATION role "%" as a non-superuser; have an administrator remove those attributes first.', existing_role;
          end if;

          if exists (
            select from pg_roles target
            where target.rolname = existing_role and target.rolcreatedb
          ) and not (select rolcreatedb from pg_roles where rolname = current_user) then
            raise exception 'Migration 0009 cannot remove CREATEDB from pre-existing role "%": current role "%" needs CREATEDB; have an administrator remove that attribute first.', existing_role, current_user;
          end if;

          if exists (select from pg_roles where rolname = existing_role)
            and not exists (
              select from pg_auth_members membership
              join pg_roles target on target.oid = membership.roleid
              where target.rolname = existing_role
                and membership.member = current_user::regrole
                and membership.admin_option
            ) then
            raise exception 'Migration 0009 cannot administer pre-existing role "%": current role "%" needs ADMIN OPTION; use a bootstrap/superuser connection or have an administrator grant ADMIN OPTION first.', existing_role, current_user;
          end if;
        end loop;
      end if;
    end
    $migration_preflight$;

    do $roles$
    begin
      if not exists (select from pg_roles where rolname = 'observatorio_migrator') then
        create role observatorio_migrator login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      else
        if (select rolsuper from pg_roles where rolname = current_user) then
          alter role observatorio_migrator with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
        else
          -- Mentioning restricted attributes requires the corresponding privilege.
          -- The preflight already rejects existing elevated service roles.
          alter role observatorio_migrator with login nocreaterole noinherit;
          if (select rolcreatedb from pg_roles where rolname = current_user) then
            alter role observatorio_migrator nocreatedb;
          end if;
        end if;
      end if;
      if not exists (select from pg_roles where rolname = 'observatorio_collector') then
        create role observatorio_collector login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      else
        if (select rolsuper from pg_roles where rolname = current_user) then
          alter role observatorio_collector with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
        else
          -- Mentioning restricted attributes requires the corresponding privilege.
          -- The preflight already rejects existing elevated service roles.
          alter role observatorio_collector with login nocreaterole noinherit;
          if (select rolcreatedb from pg_roles where rolname = current_user) then
            alter role observatorio_collector nocreatedb;
          end if;
        end if;
      end if;
      if not exists (select from pg_roles where rolname = 'observatorio_api') then
        create role observatorio_api login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      else
        if (select rolsuper from pg_roles where rolname = current_user) then
          alter role observatorio_api with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
        else
          -- Mentioning restricted attributes requires the corresponding privilege.
          -- The preflight already rejects existing elevated service roles.
          alter role observatorio_api with login nocreaterole noinherit;
          if (select rolcreatedb from pg_roles where rolname = current_user) then
            alter role observatorio_api nocreatedb;
          end if;
        end if;
      end if;
      if not exists (select from pg_roles where rolname = 'observatorio_key_admin') then
        create role observatorio_key_admin login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      else
        if (select rolsuper from pg_roles where rolname = current_user) then
          alter role observatorio_key_admin with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
        else
          -- Mentioning restricted attributes requires the corresponding privilege.
          -- The preflight already rejects existing elevated service roles.
          alter role observatorio_key_admin with login nocreaterole noinherit;
          if (select rolcreatedb from pg_roles where rolname = current_user) then
            alter role observatorio_key_admin nocreatedb;
          end if;
        end if;
      end if;
    end
    $roles$;

    do $migration_membership$
    begin
      if current_user <> 'observatorio_migrator' then
        execute format('grant observatorio_migrator to %I with set true, inherit true', current_user);
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
