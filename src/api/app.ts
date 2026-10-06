import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Database } from '../db/database.js';
import { healthRoutes } from './routes/health.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
  }
}

export interface AppDependencies {
  db: Database;
  logger?: FastifyServerOptions['logger'];
}

/**
 * Builds the Fastify app without listening, so tests can drive it with `app.inject()`.
 * The caller owns the database lifecycle.
 */
export async function buildApp({ db, logger = false }: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger });

  app.decorate('db', db);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Observatório API', version: '1.0.0' },
    },
  });

  await app.register(healthRoutes);

  return app;
}
