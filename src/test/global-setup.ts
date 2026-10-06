// Vitest global setup: creates the test database when missing and migrates it to the latest version.
import { Client } from 'pg';
import { createDatabase } from '../db/database.js';
import { migrateToLatest } from '../db/migrator.js';
import { testDatabaseUrl } from './database.js';

async function ensureDatabaseExists(url: string): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';

  const client = new Client({ connectionString: maintenance.toString() });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Could not connect to Postgres for tests at ${target.host}. Is it running? Try "npm run db:up".`,
      { cause: error },
    );
  }
  try {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [name]);
    if (!rowCount) {
      try {
        await client.query(`create database "${name.replaceAll('"', '""')}"`);
      } catch (error) {
        // 42P04 = duplicate_database: another process created it between the check and the create.
        if ((error as { code?: string }).code !== '42P04') throw error;
      }
    }
  } finally {
    await client.end();
  }
}

export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  await ensureDatabaseExists(url);
  const db = createDatabase(url, { maxConnections: 1 });
  try {
    await migrateToLatest(db);
  } finally {
    await db.destroy();
  }
}
