import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './generated/database.js';

export type Database = Kysely<DB>;

export interface DatabaseOptions {
  /** Maximum pool size. The API uses Neon's pooled endpoint with at most 5 connections. */
  maxConnections?: number;
  /** Receives errors from idle pooled clients (e.g. the server dropped the connection). Defaults to console.error. */
  onPoolError?: (error: Error) => void;
}

export function createDatabase(connectionString: string, options: DatabaseOptions = {}): Database {
  const pool = new Pool({
    connectionString,
    max: options.maxConnections ?? 5,
    connectionTimeoutMillis: 10_000,
  });
  // Without a listener, an error on an idle client is an unhandled 'error' event and crashes the process.
  const onPoolError =
    options.onPoolError ?? ((error: Error) => console.error('Unexpected error on idle Postgres client:', error));
  pool.on('error', onPoolError);
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
