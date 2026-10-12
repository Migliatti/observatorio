// Coleta CLI: `npm run collect -- <source>`. Runs one coleta against DATABASE_URL (direct connection,
// never the pooled endpoint: the per-fonte advisory lock is session-level) and exits non-zero on failure.
// Must never import from `src/api`; shares only `db`, `domain` and `sources`.
import { main } from './main.js';

process.exitCode = await main(process.argv.slice(2), { databaseUrl: process.env.DATABASE_URL });
