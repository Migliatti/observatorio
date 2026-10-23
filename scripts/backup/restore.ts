import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { tables } from './tables.js';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../../src/db/migrator.js';
import { checksum, client, localUrl, tool } from './common.js';

let phase = 'guard/checksum';
try {
  const archive = resolve(process.argv[2] ?? 'historical.dump');
  const url = localUrl(process.env.RESTORE_DATABASE_URL, 'observatorio_restore_');
  const expected = (await readFile(`${archive}.sha256`, 'utf8')).split(' ')[0];
  const actual = await checksum(archive);
  if (actual !== expected) throw new Error('Checksum mismatch');
  phase = 'empty destination check';
  const db = client(url.href);
  try {
    await db.connect();
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')`);
    if (rows[0].n !== 0) throw new Error('Restore requires an empty destination');
  } finally { await db.end(); }
  phase = 'client version';
  tool('pg_restore', ['--version']);
  phase = 'schema migrations';
  const schema = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url.href }) }) });
  try { await migrateToLatest(schema); } finally { await schema.destroy(); }
  const seed = client(url.href);
  try {
    await seed.connect();
    await seed.query('DELETE FROM public.exoplanet_catalogue');
  } finally { await seed.end(); }
  phase = 'restore data';
  // A schema+data archive does not order TABLE DATA by FK when using --data-only.
  // Keep constraints enabled and load explicitly in the contract's parent-first order.
  const toc = tool('pg_restore', ['--list', archive]).split('\n');
  const ordered = tables.map(({ name }) => {
    const matches = toc.filter((line) => line.includes(` TABLE DATA public ${name} `));
    if (matches.length !== 1) throw new Error('Unexpected archive table list');
    return matches[0]!;
  });
  ordered.push(...toc.filter((line) => line.includes(' SEQUENCE SET public ')));
  const temp = await mkdtemp(join(tmpdir(), 'observatorio-restore-'));
  try {
    const list = join(temp, 'restore.list');
    await writeFile(list, ordered.join('\n') + '\n', { mode: 0o600 });
    tool('pg_restore', ['--data-only', '--single-transaction', '--exit-on-error', '--no-owner', '--no-acl',
      '--use-list', list, '--dbname', url.pathname.slice(1), archive], url.href);
  } finally { await rm(temp, { recursive: true, force: true }); }
  phase = 'cursor rotation';
  const rotate = client(url.href);
  try {
    await rotate.connect();
    await rotate.query("UPDATE public.exoplanet_catalogue SET cursor_key = gen_random_uuid()::text || gen_random_uuid()::text");
  } finally { await rotate.end(); }
  console.log('Historical archive restored to an empty local database. API keys are not included.');
} catch {
  console.error(`Restore failed during ${phase}. Diagnostics suppressed.`);
  process.exitCode = 1;
}
