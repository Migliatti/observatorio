import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { up as initialRoles } from '../db/migrations/0009_least_privilege_roles.js';
import { up as namespaceRoles } from '../db/migrations/0010_namespace_existing_roles.js';
import { testDatabaseUrl } from './database.js';

function bootstrapDatabase(): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: testDatabaseUrl(), max: 1 }),
    }),
  });
}

it.each([
  ['0009', 'nocreatedb', initialRoles],
  ['0010', 'nocreatedb', namespaceRoles],
  ['0009', 'createdb', initialRoles],
  ['0010', 'createdb', namespaceRoles],
] as const)('%s can administer existing service roles with %s', async (_name, databasePrivilege, migrate) => {
  const db = bootstrapDatabase();
  try {
    const trx = await db.startTransaction().execute();
    try {
      await sql.raw(`
        create role observatorio_bootstrap_test createrole ${databasePrivilege} nosuperuser nobypassrls;
        grant observatorio_migrator, observatorio_collector, observatorio_api, observatorio_key_admin
          to observatorio_bootstrap_test with admin true, inherit true, set true;
        set local role observatorio_bootstrap_test;
      `).execute(trx);
      // A CREATEDB bootstrap must still remove that privilege from service roles.
      if (databasePrivilege === 'createdb') {
        await sql.raw(`
          reset role;
          alter role observatorio_migrator createdb;
          alter role observatorio_collector createdb;
          alter role observatorio_api createdb;
          alter role observatorio_key_admin createdb;
          set local role observatorio_bootstrap_test;
        `).execute(trx);
      }
      await migrate(trx);
      const { rows } = await sql<{ rolname: string; elevated: boolean; rolcanlogin: boolean }>`
        select rolname, rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication as elevated,
          rolcanlogin
        from pg_roles
        where rolname in ('observatorio_migrator', 'observatorio_collector', 'observatorio_api', 'observatorio_key_admin')
      `.execute(trx);
      expect(rows).toHaveLength(4);
      expect(rows.every((role) => role.rolcanlogin && !role.elevated)).toBe(true);
    } finally {
      // Roll back role creation, grants, and DDL even when the assertion succeeds.
      await trx.rollback().execute();
    }
  } finally {
    await db.destroy();
  }
});

it.each([
  ['0009', 'bypassrls', initialRoles],
  ['0010', 'bypassrls', namespaceRoles],
  ['0009', 'replication', initialRoles],
  ['0010', 'replication', namespaceRoles],
] as const)('%s rejects an elevated service role (%s)', async (_name, attribute, migrate) => {
  const db = bootstrapDatabase();
  try {
    await expect(db.transaction().execute(async (trx) => {
      await sql.raw(`
        create role observatorio_bootstrap_test createrole nocreatedb nosuperuser nobypassrls;
        grant observatorio_migrator, observatorio_collector, observatorio_api, observatorio_key_admin
          to observatorio_bootstrap_test with admin true, inherit true, set true;
        alter role observatorio_api ${attribute};
        set local role observatorio_bootstrap_test;
      `).execute(trx);
      await migrate(trx);
    })).rejects.toThrow('cannot alter pre-existing BYPASSRLS or REPLICATION role');
  } finally {
    await db.destroy();
  }
});

it.each([
  ['0009', initialRoles],
  ['0010', namespaceRoles],
] as const)('%s rejects CREATEDB service roles when bootstrap cannot remove it', async (_name, migrate) => {
  const db = bootstrapDatabase();
  try {
    await expect(db.transaction().execute(async (trx) => {
      await sql.raw(`
        create role observatorio_bootstrap_test createrole nocreatedb nosuperuser nobypassrls;
        grant observatorio_migrator, observatorio_collector, observatorio_api, observatorio_key_admin
          to observatorio_bootstrap_test with admin true, inherit true, set true;
        alter role observatorio_api createdb;
        set local role observatorio_bootstrap_test;
      `).execute(trx);
      await migrate(trx);
    })).rejects.toThrow('cannot remove CREATEDB from pre-existing role');
    const { rows } = await sql<{ rolcreatedb: boolean }>`
      select rolcreatedb from pg_roles where rolname = 'observatorio_api'
    `.execute(db);
    expect(rows[0]?.rolcreatedb).toBe(false);
  } finally {
    await db.destroy();
  }
});
