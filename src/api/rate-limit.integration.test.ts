import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/database.js';
import { hashApiKey } from '../db/api-key.js';
import { buildApp } from './app.js';
import { installApiKeyAuth } from './auth.js';
import { installCors, installCorsPreflight } from './cors.js';
import { installProblemHandler } from './problem.js';
import { installApiKeyRateLimit, installIpRateLimit } from './rate-limit.js';

const API_KEY = `obs_${'A'.repeat(43)}`;
const now = new Date('2026-10-15T12:00:00.000Z');
const allowedOrigin = 'https://kepler.example';
const exposedHeaders = 'ETag, Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset';

function createFakeDatabase() {
  const record = { id: 'api-key-1', consumer: 'kepler-lab', last_used_at: now };
  const filters = new Map<string, unknown>();
  const query = {
    select: () => query,
    where: (column: string, _operator: string, value: unknown) => { filters.set(column, value); return query; },
    executeTakeFirst: async () => filters.get('key_hash') === hashApiKey(API_KEY) && filters.get('revoked_at') === null ? record : undefined,
  };
  return {
    selectFrom: (table: string) => {
      if (table !== 'api_key') throw new Error(`Unexpected table: ${table}`);
      return query;
    },
  } as unknown as Database;
}

async function createApp({ ipCapacity = 30, keyCapacity = 30 }: { ipCapacity?: number; keyCapacity?: number } = {}): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate('db', createFakeDatabase());
  app.decorate('now', () => now);
  installProblemHandler(app);
  installCors(app, [allowedOrigin]);
  installIpRateLimit(app, { capacity: ipCapacity, windowSeconds: 60 });
  installCorsPreflight(app);
  installApiKeyAuth(app);
  installApiKeyRateLimit(app, { capacity: keyCapacity, refillPerSecond: 1 });
  app.get('/v1/data', async (request, reply) => {
    reply.header('ETag', '"v1"');
    if (request.headers['if-none-match'] === '"v1"') return reply.code(304).send();
    return reply.send({ data: [] });
  });
  app.get('/v1/status', async () => ({ status: 'ok' }));
  app.get('/v1/openapi.json', async () => ({ openapi: '3.1.0' }));
  app.get('/docs', async () => ({ docs: true }));
  app.get('/health', async () => ({ status: 'ok' }));
  await app.ready();
  return app;
}

describe('rate-limit and CORS hooks', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('counts a 304 against the API-key token bucket and returns a problem response at the limit', async () => {
    app = await createApp({ keyCapacity: 2 });
    const headers = { authorization: `Bearer ${API_KEY}`, origin: allowedOrigin };

    expect((await app.inject({ url: '/v1/data', headers })).statusCode).toBe(200);
    const notModified = await app.inject({ url: '/v1/data', headers: { ...headers, 'if-none-match': '"v1"' } });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.headers['ratelimit-remaining']).toBe('0');

    const limited = await app.inject({ url: '/v1/data', headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['content-type']).toContain('application/problem+json');
    expect(limited.json()).toMatchObject({ code: 'rate_limited', status: 429, title: 'Too Many Requests' });
    expect(limited.headers['retry-after']).toBe('1');
    expect(limited.headers['ratelimit-limit']).toBe('2');
    expect(limited.headers['ratelimit-remaining']).toBe('0');
    expect(limited.headers['ratelimit-reset']).toBe('2');
    expect(limited.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(limited.headers['access-control-expose-headers']).toBe(exposedHeaders);
  });

  it('applies the IP limit before authentication', async () => {
    app = await createApp({ ipCapacity: 1 });

    const headers = { origin: allowedOrigin };
    expect((await app.inject({ url: '/v1/data', headers })).json().code).toBe('invalid_api_key');
    const limited = await app.inject({ url: '/v1/data', headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('rate_limited');
    expect(limited.headers['ratelimit-limit']).toBe('1');
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.headers['access-control-allow-origin']).toBe(allowedOrigin);
  });

  it('uses forwarded client IPs only when the connecting proxy is explicitly trusted', async () => {
    app = await buildApp({
      db: createFakeDatabase(),
      now: () => now,
      rateLimits: { ip: { capacity: 1, windowSeconds: 60 }, apiKey: { capacity: 30, refillPerSecond: 1 } },
      trustedProxies: ['127.0.0.1'],
    });
    const request = (forwardedFor: string) => app!.inject({
      url: '/v1/exoplanets',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': forwardedFor },
    });

    expect((await request('198.51.100.10')).statusCode).toBe(401);
    expect((await request('198.51.100.11')).statusCode).toBe(401);
    expect((await request('198.51.100.10')).statusCode).toBe(429);
  });

  it('does not trust forwarded IP headers by default', async () => {
    app = await buildApp({
      db: createFakeDatabase(),
      now: () => now,
      rateLimits: { ip: { capacity: 1, windowSeconds: 60 }, apiKey: { capacity: 30, refillPerSecond: 1 } },
    });
    const request = (forwardedFor: string) => app!.inject({
      url: '/v1/exoplanets',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': forwardedFor },
    });

    expect((await request('198.51.100.10')).statusCode).toBe(401);
    expect((await request('198.51.100.11')).statusCode).toBe(429);
  });

  it('allows the configured origin on data routes and exposes cache and rate-limit headers', async () => {
    app = await createApp();
    const response = await app.inject({ url: '/v1/data', headers: { authorization: `Bearer ${API_KEY}`, origin: allowedOrigin } });

    expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(response.headers.vary).toContain('Origin');
    expect(response.headers['access-control-expose-headers']).toBe(exposedHeaders);
  });

  it('does not grant browser access to an origin outside the data-route allowlist', async () => {
    app = await createApp();
    const response = await app.inject({ url: '/v1/data', headers: { authorization: `Bearer ${API_KEY}`, origin: 'https://other.example' } });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows any origin on public routes and answers CORS preflight', async () => {
    app = await createApp();

    for (const url of ['/health', '/v1/status', '/v1/openapi.json', '/docs']) {
      const publicResponse = await app.inject({ url, headers: { origin: 'https://other.example' } });
      expect(publicResponse.headers['access-control-allow-origin']).toBe('*');
    }

    const preflight = await app.inject({ method: 'OPTIONS', url: '/v1/data', headers: {
      origin: allowedOrigin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization, if-none-match',
    } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(preflight.headers['access-control-allow-headers']?.toLowerCase()).toContain('authorization');
  });

  it('counts preflight requests against the IP limit before answering them', async () => {
    app = await createApp({ ipCapacity: 1 });
    const headers = { origin: allowedOrigin, 'access-control-request-method': 'GET' };

    expect((await app.inject({ method: 'OPTIONS', url: '/v1/data', headers })).statusCode).toBe(204);
    const limited = await app.inject({ method: 'OPTIONS', url: '/v1/data', headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('rate_limited');
    expect(limited.headers['access-control-allow-origin']).toBe(allowedOrigin);
  });

  it('documents rate-limited responses on data routes in OpenAPI', async () => {
    app = await buildApp({ db: createFakeDatabase(), now: () => now });
    const document = (await app.inject('/v1/openapi.json')).json();

    expect(document.paths['/v1/exoplanets'].get.responses['429']).toBeDefined();
    expect(document.paths['/v1/close-approaches'].get.responses['429']).toBeDefined();
  });
});
