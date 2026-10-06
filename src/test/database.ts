// Test-only helpers for integration tests against the real Postgres from docker-compose.
import { sql } from 'kysely';
import { createDatabase, type Database } from '../db/database.js';

const DEFAULT_TEST_DATABASE_URL = 'postgres://observatorio:observatorio@localhost:5432/observatorio_test';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validates a test database URL. Tests truncate every table, so the URL must name a "_test" database
 * on a local host (unless ALLOW_REMOTE_TEST_DATABASE=1). Returns the URL unchanged.
 */
export function validateTestDatabaseUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error('TEST_DATABASE_URL is not a valid URL (expected postgres://user:password@host:port/name_test)', {
      cause: error,
    });
  }
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (!name.endsWith('_test')) {
    throw new Error(`TEST_DATABASE_URL must point to a database whose name ends with "_test" (got "${name}")`);
  }
  if (!LOCAL_HOSTS.has(parsed.hostname) && env.ALLOW_REMOTE_TEST_DATABASE !== '1') {
    throw new Error(
      `TEST_DATABASE_URL host "${parsed.hostname}" is not local (localhost, 127.0.0.1, ::1). ` +
        'Set ALLOW_REMOTE_TEST_DATABASE=1 to run the tests against a remote database anyway.',
    );
  }
  return url;
}

export function testDatabaseUrl(): string {
  return validateTestDatabaseUrl(process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL);
}

export function createTestDatabase(): Database {
  return createDatabase(testDatabaseUrl(), { maxConnections: 2 });
}

/** Empties every application table so each test starts from a clean database. */
export async function resetDatabase(db: Database): Promise<void> {
  const { rows } = await sql<{ tablename: string }>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename not like 'kysely_migration%'
  `.execute(db);
  if (rows.length === 0) return;
  const tables = sql.join(rows.map((row) => sql.id('public', row.tablename)));
  await sql`truncate ${tables} restart identity cascade`.execute(db);
}
