import { pathToFileURL } from 'node:url';

// Keep aligned with src/domain/source.ts and src/api/routes/public.ts.
const SOURCES = ['exoplanet-archive', 'neows'];
export const REQUEST_TIMEOUT_MS = 120_000;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

function sourceList(value, label) {
  if (!Array.isArray(value) || value.length !== SOURCES.length
    || !SOURCES.every((name) => value.filter((item) => object(item) && item.name === name).length === 1)) {
    throw new Error(`${label}: expected each v1 source exactly once`);
  }
  return value;
}

export function validateStatus(body) {
  if (!object(body) || !object(body.data) || !object(body.meta)) {
    throw new Error('/v1/status: invalid envelope');
  }
  for (const source of sourceList(body.data.sources, 'data.sources')) {
    // A failed/running latest attempt does not erase a previous successful coleta.
    if (!(source.last_run_status === null || typeof source.last_run_status === 'string')
      || !(source.last_run_finished_at === null || timestamp(source.last_run_finished_at))) {
      throw new Error('data.sources: invalid run metadata');
    }
  }
  for (const source of sourceList(body.meta.sources, 'meta.sources')) {
    if (!timestamp(source.data_as_of) || typeof source.attribution !== 'string'
      || typeof source.stale !== 'boolean') {
      throw new Error('meta.sources: incomplete freshness metadata');
    }
    // The API owns the 48h freshness rule, including its exact boundary.
    if (source.stale) throw new Error(`meta.sources: ${source.name} is stale`);
  }
}

function configuredUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label}: missing or invalid URL`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password) {
    throw new Error(`${label}: expected HTTPS without embedded credentials (HTTP allowed on loopback)`);
  }
  return url;
}

async function request(url, label, timeoutMs, json) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      headers: json ? { Accept: 'application/json' } : {},
    });
    if (response.status !== 200) throw new Error('HTTP');
    if (!json) {
      await response.arrayBuffer();
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('content-type');
    return await response.json();
  } catch {
    // Never echo URLs, response bodies or fetch errors: the heartbeat URL is a secret.
    throw new Error(`${label}: request failed (HTTP, JSON, network or timeout)`);
  }
}

export async function verifyHealth({ baseUrl, successUrl, timeoutMs = REQUEST_TIMEOUT_MS, pingTimeoutMs = 15_000 }) {
  const base = configuredUrl(baseUrl, 'API_BASE_URL');
  if (base.pathname !== '/' || base.search || base.hash) throw new Error('API_BASE_URL: expected an origin');
  const ping = configuredUrl(successUrl, 'HEALTHCHECKS_VERIFY_URL');
  const health = await request(new URL('/health', base), '/health', timeoutMs, true);
  if (!object(health) || health.status !== 'ok') throw new Error('/health: expected status ok');
  validateStatus(await request(new URL('/v1/status', base), '/v1/status', timeoutMs, true));
  await request(ping, 'Healthchecks success signal', pingTimeoutMs, false);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await verifyHealth({ baseUrl: process.env.API_BASE_URL, successUrl: process.env.HEALTHCHECKS_VERIFY_URL });
    console.log('Health, source freshness and success signal verified.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
