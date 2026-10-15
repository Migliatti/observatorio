import type { FastifyInstance } from 'fastify';
import { hashApiKey } from '../db/api-key.js';
import { problem, problemSchema } from './problem.js';

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
    route.schema = {
      ...route.schema,
      security: [{ bearerAuth: [] }],
      response: { ...(route.schema?.response as Record<string, unknown> | undefined), 401: problemSchema, 429: problemSchema },
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
