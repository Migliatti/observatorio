import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Client, types } from 'pg';

// Preserve date-only values and timestamp microseconds through the logical copy.
for (const oid of [1082, 1114, 1184]) types.setTypeParser(oid, (value) => value);

export function localUrl(value: string | undefined, prefix?: string): URL {
  if (!value) throw new Error('Missing local database URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid local database URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      [...url.searchParams.keys()].some((key) => !['sslmode'].includes(key)) ||
      (prefix && !url.pathname.slice(1).startsWith(prefix))) {
    throw new Error('Local database guard rejected destination');
  }
  return url;
}

/** Source policy is deliberately Neon-specific: a host name cannot prove that an
 * arbitrary proxy is direct. No query parameter may override host, TLS or login.
 */
export function backupSourceUrl(value: string | undefined, rehearsal: boolean): URL {
  if (!value) throw new Error('Missing backup credential');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid backup URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username ||
      !url.pathname.slice(1) || url.hash ||
      [...url.searchParams.keys()].some((key) => key !== 'sslmode') ||
      url.searchParams.getAll('sslmode').length > 1) {
    throw new Error('Unsupported backup connection configuration');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (loopback) {
    if (!rehearsal) throw new Error('Loopback source requires explicit owned-cluster rehearsal');
    // Explicit values avoid ambient PGPORT/PGSSLMODE defaults even in the harness.
    url.port ||= '5432';
    if (!url.searchParams.has('sslmode')) url.searchParams.set('sslmode', 'disable');
    return url;
  }
  if (!/^ep-[a-z0-9-]+\.[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech$/.test(url.hostname) ||
      /(?:^|-)pooler(?:-|$)/.test(url.hostname.split('.')[0]!) ||
      (url.port && url.port !== '5432') || !url.password ||
      !['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode') ?? '')) {
    throw new Error('Remote backup requires direct Neon endpoint and TLS');
  }
  // Installed pg-connection-string treats require/verify-ca as verify-full aliases.
  // Normalize explicitly: certificate and hostname verification stay on even if
  // pg changes those aliases later or PGSSLMODE is set in the environment.
  url.port = '5432';
  url.searchParams.set('sslmode', 'verify-full');
  return url;
}

export function client(url: string): Client {
  return new Client({ connectionString: url, connectionTimeoutMillis: 10_000,
    statement_timeout: 120_000, application_name: 'observatorio-backup' });
}

export function tool(name: 'pg_dump' | 'pg_restore', args: string[], url?: string): string {
  // Do not inherit PGOPTIONS/PGSERVICE or expose URLs in argv/diagnostics.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME,
    LANG: 'C', PGCONNECT_TIMEOUT: '10', GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE };
  if (url) {
    const connection = new URL(url);
    Object.assign(env, { PGHOST: connection.hostname, PGPORT: connection.port || '5432',
      PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
      PGUSER: decodeURIComponent(connection.username), PGPASSWORD: decodeURIComponent(connection.password),
      PGSSLMODE: connection.searchParams.get('sslmode') ?? 'prefer' });
  }
  const version = spawnSync(name, ['--version'], { env, encoding: 'utf8' });
  if (version.status !== 0 || !/\(PostgreSQL\) 18\./.test(version.stdout ?? '')) {
    throw new Error('PostgreSQL 18 client required');
  }
  const result = spawnSync(name, args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
  if (result.status !== 0 || result.error) throw new Error('Postgres tool failed; diagnostics suppressed');
  return result.stdout.toString('utf8');
}

export async function checksum(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
