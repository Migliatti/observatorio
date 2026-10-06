// Coleta CLI (stub). Runs a coleta for one fonte against DATABASE_URL (direct connection).
// Must never import from `src/api`; shares only `db`, `domain` and `sources`.
import { SOURCES, isSource } from '../domain/source.js';

const [sourceArg] = process.argv.slice(2);

if (!sourceArg || !isSource(sourceArg)) {
  console.error(`Usage: npm run collect -- <source>\nKnown sources: ${SOURCES.join(', ')}`);
  process.exit(1);
}

console.error(`Coleta for "${sourceArg}" is not implemented yet.`);
process.exit(1);
