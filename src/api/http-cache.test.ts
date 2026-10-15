import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installSourceCache } from './http-cache.js';

describe('conditional HTTP cache for data routes', () => {
  let app: FastifyInstance;
  let dataAsOf: string;
  let lastRunStatus: string;

  beforeEach(async () => {
    dataAsOf = '2026-10-10T00:00:00.000Z';
    lastRunStatus = 'succeeded';
    app = Fastify();
    installSourceCache(app);
    app.get('/v1/exoplanets', async () => ({
      data: [{ name: 'Kepler-1 b' }],
      meta: { sources: [{ name: 'exoplanet-archive', data_as_of: dataAsOf, stale: false }] },
      last_run_status: lastRunStatus,
    }));
    app.get('/v1/status', async () => ({ data: { sources: [] }, meta: { sources: [] } }));
    await app.ready();
  });

  afterEach(async () => app.close());

  it('returns 304 for a matching validator and changes it only after a successful coleta', async () => {
    const first = await app.inject('/v1/exoplanets');
    const firstEtag = first.headers.etag;
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-cache');
    expect(firstEtag).toEqual(expect.any(String));

    const unchanged = await app.inject({ url: '/v1/exoplanets', headers: { 'if-none-match': firstEtag! } });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe('');
    expect(unchanged.headers.etag).toBe(firstEtag);

    dataAsOf = '2026-10-11T00:00:00.000Z';
    const refreshed = await app.inject('/v1/exoplanets');
    expect(refreshed.headers.etag).not.toBe(firstEtag);

    lastRunStatus = 'failed';
    const afterFailure = await app.inject('/v1/exoplanets');
    expect(afterFailure.headers.etag).toBe(refreshed.headers.etag);
  });

  it('does not cache the public status endpoint', async () => {
    const response = await app.inject('/v1/status');
    expect(response.headers.etag).toBeUndefined();
    expect(response.headers['cache-control']).toBeUndefined();
  });
});
