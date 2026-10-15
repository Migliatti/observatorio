import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Database } from '../db/database.js';
import { exoplanetRoutes } from './routes/exoplanets.js';
import { installProblemHandler } from './problem.js';
import { healthRoutes } from './routes/health.js';
import { publicRoutes } from './routes/public.js';
import { revisionRoutes } from './routes/revisions.js';
import { closeApproachRoutes } from './routes/close-approaches.js';
import { installApiKeyAuth } from './auth.js';
import { installCors, installCorsPreflight } from './cors.js';
import { installApiKeyRateLimit, installIpRateLimit, type RateLimitPolicies } from './rate-limit.js';
import { installSourceCache } from './http-cache.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    now: () => Date;
  }
}

export interface AppDependencies {
  db: Database;
  logger?: FastifyServerOptions['logger'];
  now?: () => Date;
  rateLimits?: RateLimitPolicies;
  corsOrigins?: readonly string[];
  trustedProxies?: readonly string[];
}

/**
 * Builds the Fastify app without listening, so tests can drive it with `app.inject()`.
 * The caller owns the database lifecycle.
 */
export async function buildApp({
  db,
  logger = false,
  now = () => new Date(),
  rateLimits = { ip: { capacity: 30, windowSeconds: 60 }, apiKey: { capacity: 30, refillPerSecond: 1 } },
  corsOrigins = ['https://kepler-lab-gamma.vercel.app', 'http://localhost:5173', 'http://localhost:3000'],
  trustedProxies = [],
}: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger, trustProxy: trustedProxies.length > 0 ? [...trustedProxies] : false });

  app.decorate('db', db);
  app.decorate('now', now);
  installProblemHandler(app);
  installCors(app, corsOrigins);
  installIpRateLimit(app, rateLimits.ip);
  installCorsPreflight(app);
  installApiKeyAuth(app);
  installApiKeyRateLimit(app, rateLimits.apiKey);
  installSourceCache(app);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Observatório API', version: '1.0.0' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    },
  });

  await app.register(healthRoutes);
  await app.register(publicRoutes);
  await app.register(exoplanetRoutes);
  await app.register(revisionRoutes);
  await app.register(closeApproachRoutes);

  return app;
}
