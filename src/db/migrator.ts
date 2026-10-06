import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.(ts|js)$/;

/**
 * Loads forward-only migrations from `src/db/migrations` (or `dist/db/migrations` once built).
 * Each file exports only `up`; there is no `down` by design.
 * Imports go through file URLs so absolute Windows paths work under ESM.
 */
class ForwardOnlyMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => MIGRATION_FILE.test(file)).toSorted();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const module = (await import(pathToFileURL(join(MIGRATIONS_DIR, file)).href)) as Partial<Migration>;
      if (typeof module.up !== 'function') {
        throw new Error(`Migration ${file} must export an "up" function`);
      }
      if ('down' in module) {
        throw new Error(`Migration ${file} exports "down"; migrations are forward-only`);
      }
      migrations[file.replace(/\.(ts|js)$/, '')] = { up: module.up };
    }
    return migrations;
  }
}

export interface MigrationOutcome {
  applied: string[];
}

// Migrations run before the generated types match the schema, so they take an untyped Kysely.
// eslint-disable-next-line typescript/no-explicit-any
export async function migrateToLatest(db: Kysely<any>): Promise<MigrationOutcome> {
  const migrator = new Migrator({ db, provider: new ForwardOnlyMigrationProvider() });
  const { error, results = [] } = await migrator.migrateToLatest();
  const failed = results.find((result) => result.status === 'Error');
  if (error || failed) {
    const name = failed ? ` (${failed.migrationName})` : '';
    throw new Error(`Migration failed${name}`, { cause: error });
  }
  return { applied: results.map((result) => result.migrationName) };
}
