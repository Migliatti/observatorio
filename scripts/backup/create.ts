import { randomUUID } from 'node:crypto';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { backupSourceUrl, checksum, client, localUrl, tool } from './common.js';
import { tables, revisionFields } from './tables.js';

async function main(): Promise<void> {
  const output = resolve(process.argv[2] ?? 'historical.dump');
  const staging = localUrl(process.env.BACKUP_STAGING_DATABASE_URL);
  const stageName = `observatorio_backup_${randomUUID().replaceAll('-', '')}`;
  const admin = client(staging.href);
  const sourceUrl = backupSourceUrl(process.env.BACKUP_DATABASE_URL,
    process.env.BACKUP_REHEARSAL_OWN_CLUSTER === 'yes');
  const source = client(sourceUrl.href);
  const stageUrl = new URL(staging);
  stageUrl.pathname = `/${stageName}`;
  const stage = client(stageUrl.href);
  let created = false;
  let work: string | undefined;
  let schema: Kysely<unknown> | undefined;
  try {
    if (!process.env.BACKUP_DATABASE_URL) throw new Error('Missing backup credential');
    tool('pg_dump', ['--version']);
    await source.connect();
    // One read-only repeatable snapshot covers every table, even during collection.
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const role = await source.query(`SELECT r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR
      r.rolreplication OR r.rolbypassrls AS elevated,
      EXISTS (SELECT FROM pg_auth_members m WHERE m.member = r.oid) AS membership,
      has_database_privilege(current_user, current_database(), 'CREATE') AS db_create,
      has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
      has_any_column_privilege(current_user, 'public.api_key', 'SELECT,INSERT,UPDATE,REFERENCES') OR
      has_table_privilege(current_user, 'public.api_key', 'DELETE,TRUNCATE,TRIGGER') AS keys
      FROM pg_roles r WHERE rolname = current_user`);
    if (!role.rows[0] || Object.values(role.rows[0]).some(Boolean)) throw new Error('Backup role is too privileged');
    for (const { name } of tables) {
      const rights = await source.query(`SELECT
        has_table_privilege(current_user, $1, 'SELECT') AS readable,
        has_any_column_privilege(current_user, $1, 'INSERT,UPDATE,REFERENCES') OR
        has_table_privilege(current_user, $1, 'DELETE,TRUNCATE,TRIGGER') AS writable`, [`public.${name}`]);
      if (!rights.rows[0]?.readable || rights.rows[0].writable) throw new Error('Read-only backup role required');
    }
    await admin.connect();
    await admin.query(`CREATE DATABASE "${stageName}"`);
    created = true;
    schema = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: stageUrl.href }) }) });
    // Freeze the public archive schema. Roles/keys and migration state are never exported.
    for (const migration of [
      '0001_create_ingestion_run', '0002_create_exoplanet', '0003_create_exoplanet_revision',
      '0004_exoplanet_sort_indexes', '0005_create_asteroid_close_approach', '0006_create_exoplanet_catalogue',
      '0007_create_api_key', '0008_ingestion_run_coverage',
    ]) {
      const { up } = await import(`../../src/db/migrations/${migration}.js`);
      await up(schema);
    }
    await schema.destroy();
    schema = undefined;
    await stage.connect();
    // Migration 0006 seeds one catalogue; the staging database is disposable and private.
    await stage.query('DELETE FROM exoplanet_catalogue');
    const counts: Record<string, number> = {};
    for (const { name, columns } of tables) {
      const selection = columns.map((column) => column === 'parameters'
        ? `jsonb_strip_nulls(jsonb_build_object(${revisionFields.map((key) => `'${key}', parameters->'${key}'`).join(',')})) AS parameters`
        : `"${column}"`).join(',');
      await source.query(`DECLARE backup_rows NO SCROLL CURSOR FOR SELECT ${selection} FROM public."${name}"`);
      counts[name] = 0;
      while (true) {
        const rows = await source.query('FETCH 500 FROM backup_rows');
        if (!rows.rowCount) break;
        const names = [...columns];
        const raw = ['exoplanet', 'asteroid', 'close_approach'].includes(name);
        if (raw) names.push('raw');
        const values: unknown[] = [];
        const placeholders = rows.rows.map((row) => {
          const cells = columns.map((column) => row[column]);
          if (raw) cells.push({});
          return '(' + cells.map((cell) => { values.push(cell); return `$${values.length}`; }).join(',') + ')';
        });
        await stage.query(`INSERT INTO public."${name}" (${names.map((c) => `"${c}"`).join(',')})
          OVERRIDING SYSTEM VALUE VALUES ${placeholders.join(',')}`, values);
        counts[name] += rows.rowCount!;
      }
      await source.query('CLOSE backup_rows');
      if (name !== 'exoplanet_catalogue_item') {
        // Every identity sequence is included explicitly in pg_dump below.
        await stage.query(`SELECT setval(pg_get_serial_sequence('public.${name}', 'id'),
          COALESCE((SELECT max(id) FROM public."${name}"), 1),
          EXISTS(SELECT FROM public."${name}"))`);
      }
    }
    await source.query('COMMIT');
    await stage.query("UPDATE exoplanet_catalogue SET cursor_key = ''");
    work = await mkdtemp(join(tmpdir(), 'observatorio-backup-'));
    const archive = join(work, 'historical.dump');
    tool('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--no-comments', '--no-security-labels',
      '--no-large-objects', '--strict-names', '--exclude-table=public.api_key',
      ...tables.flatMap(({ name }) => [`--table=public.${name}`,
        ...(name === 'exoplanet_catalogue_item' ? [] : [`--table=public.${name}_id_seq`])]),
      '--file', archive], stageUrl.href);
    const digest = await checksum(archive);
    await writeFile(`${archive}.sha256`, `${digest}  historical.dump\n`, { mode: 0o600 });
    await writeFile(`${archive}.json`, JSON.stringify({ format: 1, postgres: 18,
      created_at: new Date().toISOString(), counts,
      omitted: ['api_key', 'raw', 'ingestion_run.error', 'exoplanet_catalogue.cursor_key'],
    }, null, 2) + '\n', { mode: 0o600 });
    // Publish files only after a successful dump; workflow uploads these exact paths.
    await rename(archive, output);
    await rename(`${archive}.sha256`, `${output}.sha256`);
    await rename(`${archive}.json`, `${output}.json`);
    console.log('Sanitized historical backup complete.');
  } catch {
    console.error('Backup failed. No diagnostic data or credentials are logged.');
    process.exitCode = 1;
  } finally {
    await schema?.destroy();
    await source.end().catch(() => {});
    await stage.end().catch(() => {});
    if (created) {
      try { await admin.query(`DROP DATABASE "${stageName}"`); }
      catch { console.error('Temporary staging cleanup failed.'); process.exitCode = 1; }
    }
    await admin.end().catch(() => {});
    if (work) await rm(work, { recursive: true, force: true });
  }

}
await main().catch(() => {
  console.error('Backup configuration invalid. Diagnostics suppressed.');
  process.exitCode = 1;
});
