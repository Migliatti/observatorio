import type { FastifyInstance } from 'fastify';
import { hashApiKey } from '../db/api-key.js';
import { problem, problemResponseSchema } from './problem.js';

const CACHE_MS = 60_000;
const LAST_USED_MS = 5 * 60_000;
const PUBLIC_ROUTES = new Set(['/v1/status', '/v1/openapi.json']);
const KEY_PATTERN = /^Bearer (obs_[A-Za-z0-9_-]{43})$/;
export const isDataRoute = (url: string) => url.startsWith('/v1/') && !PUBLIC_ROUTES.has(url);

declare module 'fastify' {
  interface FastifyRequest {
    apiKey: { id: string; consumer: string } | null;
  }
}

/** Install before registering data routes; the cache lives only as long as this app. */
export function installApiKeyAuth(app: FastifyInstance): void {
  const cache = new Map<string, { id: string; consumer: string; expiresAt: number; lastUsedAt: number }>();
  app.decorateRequest('apiKey', null);
  app.addHook('onRoute', (route) => {
    if (!isDataRoute(route.url)) return;
    const rateLimitHeaders = {
      'RateLimit-Limit': { type: 'integer', description: 'Maximum requests allowed by the active limit.' },
      'RateLimit-Remaining': { type: 'integer', description: 'Requests remaining in the active limit.' },
      'RateLimit-Reset': { type: 'integer', description: 'Seconds until the active limit resets.' },
    };
    const response = { ...(route.schema?.response as Record<string, Record<string, unknown>> | undefined) };
    const success = response['200'];
    if (success) {
      response['200'] = {
        ...success,
        headers: {
          ...rateLimitHeaders,
          ETag: { type: 'string', description: 'Validator for this successful representation.' },
          'Cache-Control': { type: 'string', description: 'Cache policy for this representation.' },
        },
      };
      response['304'] = {
        type: 'null', description: 'The representation has not changed.',
        headers: {
          ...rateLimitHeaders,
          ETag: { type: 'string', description: 'Validator for this representation.' },
          'Cache-Control': { type: 'string', description: 'Cache policy for this representation.' },
        },
      };
    }
    route.schema = {
      ...route.schema,
      security: [{ bearerAuth: [] }],
      response: {
        ...response,
        401: problemResponseSchema,
        429: {
          ...problemResponseSchema,
          headers: { ...rateLimitHeaders, 'Retry-After': { type: 'integer', description: 'Seconds to wait before retrying.' } },
        },
      },
    };
  });
  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0]!;
    if (!isDataRoute(pathname)) return;
    const match = KEY_PATTERN.exec(request.headers.authorization ?? '');
    if (!match) return problem(reply, 401, 'invalid_api_key', 'A valid Bearer API key is required.');
    const hash = hashApiKey(match[1]!);
    const now = app.now();
    const currentTime = now.getTime();
    let entry = cache.get(hash);
    if (!entry || currentTime >= entry.expiresAt) {
      cache.delete(hash);
      const record = await app.db.selectFrom('api_key').select(['id', 'consumer', 'last_used_at'])
        .where('key_hash', '=', hash).where('revoked_at', 'is', null).executeTakeFirst();
      if (!record) return problem(reply, 401, 'invalid_api_key', 'A valid Bearer API key is required.');
      entry = { id: record.id, consumer: record.consumer, expiresAt: currentTime + CACHE_MS,
        lastUsedAt: record.last_used_at?.getTime() ?? Number.NEGATIVE_INFINITY };
      if (cache.size >= 10_000) cache.delete(cache.keys().next().value!);
      cache.set(hash, entry);
    }
    request.apiKey = { id: entry.id, consumer: entry.consumer };
    if (currentTime - entry.lastUsedAt >= LAST_USED_MS) {
      // Set locally before awaiting so concurrent requests cannot schedule repeated writes.
      entry.lastUsedAt = currentTime;
      await app.db.updateTable('api_key').set({ last_used_at: now }).where('id', '=', entry.id)
        .where((eb) => eb.or([
          eb('last_used_at', 'is', null), eb('last_used_at', '<=', new Date(currentTime - LAST_USED_MS)),
        ])).execute();
    }
  });
}
