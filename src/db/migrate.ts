// CLI: applies pending migrations to DATABASE_URL (direct connection, never the pooled endpoint).
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrator.js';

const url = process.env.DATABASE_URL;
if (!url || !/^postgres(ql)?:\/\/.+/.test(url)) {
  console.error('DATABASE_URL is missing or is not a postgres:// connection string. See .env.example.');
  process.exit(1);
}

const db = createDatabase(url, { maxConnections: 1 });
try {
  const { applied } = await migrateToLatest(db);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
