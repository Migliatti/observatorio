import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDatabase, type Database } from '../db/database.js';
import { buildApp } from './app.js';

describe('GET /health', () => {
  let db: Database;
  let app: FastifyInstance;

  beforeAll(async () => {
    // Points at a port where nothing listens: any database query would fail the request.
    db = createDatabase('postgres://nobody:nothing@127.0.0.1:1/unreachable');
    app = await buildApp({ db });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('responds 200 without touching the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('is left out of the OpenAPI document', () => {
    const document = app.swagger() as { paths?: Record<string, unknown> };

    expect(Object.keys(document.paths ?? {})).not.toContain('/health');
  });
});
