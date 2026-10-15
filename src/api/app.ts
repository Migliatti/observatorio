import swagger from '@fastify/swagger';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Database } from '../db/database.js';
import { exoplanetRoutes } from './routes/exoplanets.js';
import { installProblemHandler } from './problem.js';
import { healthRoutes } from './routes/health.js';
import { publicRoutes } from './routes/public.js';
import { revisionRoutes } from './routes/revisions.js';
import { closeApproachRoutes } from './routes/close-approaches.js';
import { installApiKeyAuth } from './auth.js';
import { installRequestLogging } from './request-logging.js';

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
}

/**
 * Builds the Fastify app without listening, so tests can drive it with `app.inject()`.
 * The caller owns the database lifecycle.
 */
export async function buildApp({ db, logger = false, now = () => new Date() }: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger, logController: new LogController({ disableRequestLogging: true }) });

  app.decorate('db', db);
  app.decorate('now', now);
  installProblemHandler(app);
  installRequestLogging(app);
  installApiKeyAuth(app);

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
