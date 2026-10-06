import type { FastifyInstance } from 'fastify';

/** Liveness probe: never touches the database and is hidden from the OpenAPI document. */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { schema: { hide: true } }, async () => ({ status: 'ok' }));
}
