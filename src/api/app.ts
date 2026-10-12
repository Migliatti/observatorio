import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Database } from '../db/database.js';
import { exoplanetRoutes } from './routes/exoplanets.js';
import { installProblemHandler } from './problem.js';
import { healthRoutes } from './routes/health.js';

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
  const app = Fastify({ logger });

  app.decorate('db', db);
  app.decorate('now', now);
  installProblemHandler(app);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Observatório API', version: '1.0.0' },
    },
  });

  await app.register(healthRoutes);
  await app.register(exoplanetRoutes);

  return app;
}
