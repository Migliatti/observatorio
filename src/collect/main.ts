// Entry point of the coleta CLI, separated from cli.ts so tests can run it with an injected fonte.
import { createDatabase, type Database } from '../db/database.js';
import { SOURCES, isSource, type Source } from '../domain/source.js';
import type { HttpOptions } from '../sources/http.js';
import { exoplanetArchiveCollector } from './exoplanet-archive.js';
import { runCollection, type CollectionResult } from './run.js';

export interface CliDependencies {
  /** Direct (non-pooled) Postgres connection string. */
  databaseUrl: string | undefined;
  /** HTTP settings for the fontes; tests inject a fetch that serves fixtures. */
  http?: HttpOptions;
  now?: () => Date;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

/** Runs `collect <source>` and returns the process exit code (0 on success, 1 on any failure). */
export async function main(args: readonly string[], deps: CliDependencies): Promise<number> {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;

  const [source] = args;
  if (!source || !isSource(source)) {
    logError(`Usage: npm run collect -- <source>\nKnown sources: ${SOURCES.join(', ')}`);
    return 1;
  }
  const url = deps.databaseUrl;
  if (!url || !/^postgres(ql)?:\/\/.+/.test(url)) {
    logError('DATABASE_URL is missing or is not a postgres:// connection string. See .env.example.');
    return 1;
  }

  const db = createDatabase(url, { maxConnections: 1 });
  try {
    const result = await collect(db, source, deps);
    log(
      `Coleta of "${source}" succeeded (run ${result.runId}): ` +
        `${result.seen} seen, ${result.created} created, ${result.revised} revised.`,
    );
    return 0;
  } catch (error) {
    logError(`Coleta of "${source}" failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await db.destroy();
  }
}

function collect(db: Database, source: Source, deps: CliDependencies): Promise<CollectionResult> {
  switch (source) {
    case 'exoplanet-archive':
      return runCollection(db, source, exoplanetArchiveCollector(deps.http), deps.now);
    case 'neows':
      return Promise.reject(new Error('Coleta of "neows" is not implemented yet.'));
  }
}
