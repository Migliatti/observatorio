// Requires an exclusively owned disposable PostgreSQL cluster, never a shared test database.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { client, localUrl } from './common.js';
import { tables } from './tables.js';
import { migrateToLatest } from '../../src/db/migrator.js';

assert.equal(process.env.BACKUP_REHEARSAL_OWN_CLUSTER, 'yes', 'Explicitly acknowledge cluster ownership');
const adminUrl = localUrl(process.env.BACKUP_STAGING_DATABASE_URL);
const admin = client(adminUrl.href);
const directory = await mkdtemp(join(tmpdir(), 'observatorio-rehearsal-'));
const archive = join(directory, 'historical.dump');
const sourceUrl = new URL(adminUrl); sourceUrl.pathname = '/observatorio_backup_source';
const restoreUrl = new URL(adminUrl); restoreUrl.pathname = '/observatorio_restore_rehearsal';
const source = client(sourceUrl.href);
const restored = client(restoreUrl.href);
const sentinel = 'SYNTHETIC_SECRET_MUST_NOT_SURVIVE_30';
const keyHash = 'f'.repeat(64);
function run(script: string, env: NodeJS.ProcessEnv, ok: boolean, file = archive): string {
  const result = spawnSync(process.execPath, ['--import', 'tsx', `scripts/backup/${script}.ts`, file], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000,
  });
  const output = result.stdout + result.stderr;
  assert(!output.includes(sentinel));
  assert(!output.includes(adminUrl.href));
  assert.equal(result.status === 0, ok, `${script} returned unexpected status (diagnostics suppressed)`);
  return output;
}
try {
  await admin.connect();
  // No IF NOT EXISTS: an existing name must stop the rehearsal, never reuse data.
  await admin.query('CREATE DATABASE observatorio_backup_source');
  await admin.query('CREATE DATABASE observatorio_restore_rehearsal');
  const schema = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: sourceUrl.href }) }) });
  try { await migrateToLatest(schema); } finally { await schema.destroy(); }
  await source.connect();
  await source.query(`INSERT INTO ingestion_run(id,source,status,started_at,finished_at,error,coverage_from,coverage_to)
    OVERRIDING SYSTEM VALUE VALUES(101,'neows','succeeded','2026-01-01T00:00:00.123456Z','2026-01-02',$1,'2026-01-01','2026-01-02')`, [sentinel]);
  await source.query(`INSERT INTO exoplanet(id,name,raw,first_seen_at,last_seen_at,removed_at,radius_earth_radii)
    OVERRIDING SYSTEM VALUE VALUES(201,'Synthetic b',$1,'2026-01-01','2026-01-02','2026-01-03',2)`, [{ api_key: sentinel }]);
  await source.query(`INSERT INTO exoplanet_revision(id,exoplanet_id,parameters,content_hash,recorded_at)
    OVERRIDING SYSTEM VALUE VALUES(301,201,$1,'old-hash','2026-01-01')`, [{ name: 'Synthetic b', radius_earth_radii: 1, raw: sentinel, api_key: sentinel }]);
  await source.query(`UPDATE exoplanet_catalogue SET cursor_key=$1, ingestion_run_id=101, data_as_of='2026-01-02'`, [sentinel]);
  await source.query(`INSERT INTO exoplanet_catalogue_item(id,name,first_seen_at,last_seen_at,catalogue_id)
    SELECT 201,'Synthetic b','2026-01-01','2026-01-02',id FROM exoplanet_catalogue`);
  await source.query(`INSERT INTO asteroid(id,jpl_id,name,is_potentially_hazardous,raw,first_seen_at,last_seen_at)
    OVERRIDING SYSTEM VALUE VALUES(401,'synthetic-jpl','Synthetic asteroid',false,$1,'2026-01-01','2026-01-02')`, [{ links: { self: `https://example.invalid/?api_key=${sentinel}` } }]);
  await source.query(`INSERT INTO close_approach(id,asteroid_id,date,approach_at,raw,first_seen_at,last_seen_at)
    OVERRIDING SYSTEM VALUE VALUES(501,401,'2026-01-02','2026-01-02T12:00:00Z',$1,'2026-01-01','2026-01-02')`, [{ token: sentinel }]);
  await source.query(`INSERT INTO api_key(key_hash,prefix,consumer) VALUES($1,'test',$2)`, [keyHash, sentinel]);
  await admin.query('CREATE ROLE observatorio_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION');
  await source.query('GRANT USAGE ON SCHEMA public TO observatorio_backup');
  await source.query(`GRANT SELECT ON TABLE ${tables.map(({ name }) => `public.${name}`).join(',')} TO observatorio_backup`);
  const reader = new URL(sourceUrl); reader.username = 'observatorio_backup'; reader.password = '';
  const backupEnv = { BACKUP_DATABASE_URL: reader.href, BACKUP_STAGING_DATABASE_URL: adminUrl.href };
  for (const role of [adminUrl.username, 'observatorio_api', 'observatorio_collector', 'observatorio_migrator']) {
    const invalid = new URL(sourceUrl); invalid.username = role; invalid.password = '';
    run('create', { ...backupEnv, BACKUP_DATABASE_URL: invalid.href }, false);
  }
  run('create', { ...backupEnv, BACKUP_DATABASE_URL: `postgres://bad:${sentinel}@[invalid` }, false);
  console.log('PASS owner/API/collector/migrator and malformed credentials rejected without leaking diagnostics');
  const denied = client(reader.href);
  try {
    await denied.connect();
    await assert.rejects(denied.query('SELECT * FROM api_key'), (error: unknown) => (error as { code: string }).code === '42501');
    await assert.rejects(denied.query('UPDATE ingestion_run SET status=status'), (error: unknown) => (error as { code: string }).code === '42501');
  } finally { await denied.end(); }
  console.log('PASS dedicated reader cannot read keys or write historical data');
  run('create', backupEnv, true);
  const contents = spawnSync('pg_restore', ['--file=-', archive], { encoding: 'utf8' });
  assert.equal(contents.status, 0);
  assert(!contents.stdout.includes(sentinel));
  assert(!contents.stdout.includes(keyHash));
  assert(!contents.stdout.includes('api_key'));
  console.log('PASS decompressed archive excludes key table, hash, raw JSON, errors and cursor secret');
  run('restore', { RESTORE_DATABASE_URL: 'postgres://test@example.invalid/observatorio_restore_invalid' }, false);
  const checksum = await readFile(`${archive}.sha256`);
  await writeFile(`${archive}.sha256`, '0'.repeat(64));
  run('restore', { RESTORE_DATABASE_URL: restoreUrl.href }, false);
  await writeFile(`${archive}.sha256`, checksum);
  run('restore', { RESTORE_DATABASE_URL: restoreUrl.href }, true);
  await restored.connect();
  for (const { name } of tables) {
    const a = await source.query(`SELECT count(*)::int AS n FROM ${name}`);
    const b = await restored.query(`SELECT count(*)::int AS n FROM ${name}`);
    assert.deepEqual(b.rows, a.rows);
  }
  assert.equal((await restored.query('SELECT count(*)::int AS n FROM api_key')).rows[0].n, 0);
  const history = (await restored.query(`SELECT e.removed_at IS NOT NULL AS removed,
    e.radius_earth_radii AS current, r.parameters->>'radius_earth_radii' AS previous
    FROM exoplanet e JOIN exoplanet_revision r ON r.exoplanet_id=e.id`)).rows[0];
  assert.deepEqual(history, { removed: true, current: 2, previous: '1' });
  assert.equal((await restored.query(`SELECT to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS t FROM ingestion_run`)).rows[0].t, '2026-01-01 00:00:00.123456');
  assert.equal((await restored.query(`SELECT date::text AS d FROM close_approach`)).rows[0].d, '2026-01-02');
  assert.equal((await restored.query('SELECT error FROM ingestion_run')).rows[0].error, null);
  assert.deepEqual((await restored.query('SELECT raw FROM asteroid')).rows[0].raw, {});
  assert.notEqual((await restored.query('SELECT cursor_key FROM exoplanet_catalogue')).rows[0].cursor_key, sentinel);
  assert.equal((await restored.query(`SELECT nextval('public.close_approach_id_seq')::int AS id`)).rows[0].id, 502);
  console.log('PASS all seven table counts, previous revision, removed planet, approaches, microseconds, dates and identity sequences restored');
  run('restore', { RESTORE_DATABASE_URL: restoreUrl.href }, false);
  console.log('PASS remote/nonempty destinations and invalid checksum rejected');
  // Test documented key recreation without printing the generated token.
  const keys = spawnSync(process.execPath, ['--import', 'tsx', 'src/keys/cli.ts', 'create', 'synthetic-consumer'], {
    env: { ...process.env, KEYS_DATABASE_URL: restoreUrl.href }, encoding: 'utf8',
  });
  assert.equal(keys.status, 0);
  assert.equal((await restored.query('SELECT count(*)::int AS n FROM api_key')).rows[0].n, 1);
  console.log('PASS key recreation CLI (plaintext captured privately, never logged)');
  const leftovers = await admin.query("SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'observatorio_backup_%' AND datname <> 'observatorio_backup_source'");
  assert.equal(leftovers.rows[0].n, 0);
  console.log('PASS staging databases cleaned after backup');
  console.log(`Evidence: PostgreSQL ${(await source.query('SHOW server_version')).rows[0].server_version}; synthetic counts: 1 per table; no production access`);
} finally {
  await source.end().catch(() => {});
  await restored.end().catch(() => {});
  await admin.end().catch(() => {});
}
// Keep the synthetic files in /tmp for review. The owning harness stops the whole cluster.
