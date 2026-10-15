import type { FastifyInstance } from 'fastify';

/** Emit one bounded, credential-free completion record for every HTTP request. */
export function installRequestLogging(app: FastifyInstance): void {
  app.addHook('onResponse', async (request, reply) => {
    const fields = {
      method: request.method,
      route: request.routeOptions.url ?? null,
      statusCode: reply.statusCode,
      responseTimeMs: Number(reply.elapsedTime.toFixed(3)),
      notModified: reply.statusCode === 304,
      keyId: request.apiKey?.id.slice(-6) ?? null,
      problemCode: request.problemCode,
      errorType: request.errorType,
    };

    if (reply.statusCode >= 500) request.log.error(fields, 'request completed');
    else if (reply.statusCode >= 400) request.log.warn(fields, 'request completed');
    else request.log.info(fields, 'request completed');
  });
}
