import type { FastifyInstance } from 'fastify';

const EXPOSED_HEADERS = 'ETag, Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset';
const PUBLIC_PATHS = new Set(['/health', '/v1/status', '/v1/openapi.json', '/docs']);

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

/** Installs CORS headers for data routes and the public discovery endpoints. */
export function installCors(app: FastifyInstance, allowedOrigins: readonly string[]): void {
  const allowlist = new Set(allowedOrigins.map((origin) => origin.trim()).filter(Boolean));
  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0]!;
    const origin = request.headers.origin;
    const publicPath = isPublicPath(pathname);
    const allowed = publicPath || (origin !== undefined && allowlist.has(origin));

    if (origin && allowed) {
      reply.header('Access-Control-Allow-Origin', publicPath ? '*' : origin);
      if (!publicPath) reply.header('Vary', 'Origin');
      reply.header('Access-Control-Expose-Headers', EXPOSED_HEADERS);
    }

  });
}

/** Answers preflight after the IP limiter has counted the request and before auth. */
export function installCorsPreflight(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'OPTIONS' || !request.headers['access-control-request-method']) return;
    reply.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Authorization, If-None-Match');
    return reply.code(204).send();
  });
}
