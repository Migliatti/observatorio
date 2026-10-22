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
  ['0009', initialRoles],
  ['0010', namespaceRoles],
] as const)('%s can administer existing service roles without SUPERUSER or BYPASSRLS', async (_name, migrate) => {
  const db = bootstrapDatabase();
  try {
    const trx = await db.startTransaction().execute();
    try {
      await sql.raw(`
        create role observatorio_bootstrap_test createrole createdb nosuperuser nobypassrls;
        grant observatorio_migrator, observatorio_collector, observatorio_api, observatorio_key_admin
          to observatorio_bootstrap_test with admin true, inherit true, set true;
        set local role observatorio_bootstrap_test;
      `).execute(trx);
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
  ['0009', initialRoles, 'bypassrls'],
  ['0010', namespaceRoles, 'bypassrls'],
  ['0009', initialRoles, 'replication'],
  ['0010', namespaceRoles, 'replication'],
] as const)('%s rejects an elevated service role (%s)', async (_name, migrate, attribute) => {
  const db = bootstrapDatabase();
  try {
    await expect(db.transaction().execute(async (trx) => {
      await sql.raw(`
        create role observatorio_bootstrap_test createrole createdb nosuperuser nobypassrls;
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
