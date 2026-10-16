import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import { createTestDatabase, resetDatabase } from '../test/database.js';
import { buildApp } from './app.js';

describe('public API discovery', () => {
  let db: Database;
  let app: FastifyInstance;
  const now = new Date('2026-10-12T12:00:00Z');
  beforeAll(async () => { db = createTestDatabase(); app = await buildApp({ db, now: () => now }); await app.ready(); });
  beforeEach(async () => { await resetDatabase(db); });
  afterAll(async () => { await app.close(); await db.destroy(); });

  it('serves status without a key, keeping successful freshness after a failed coleta', async () => {
    await db.insertInto('ingestion_run').values([
      { source: 'neows', status: 'succeeded', finished_at: new Date('2026-10-12T10:00:00Z') },
      { source: 'neows', status: 'failed', finished_at: new Date('2026-10-12T11:00:00Z') },
    ]).execute();
    const response = await app.inject('/v1/status');
    expect(response.statusCode).toBe(200);
    const sources = response.json().meta.sources;
    expect(sources).toEqual([
      expect.objectContaining({ name: 'exoplanet-archive', data_as_of: null, stale: true }),
      expect.objectContaining({ name: 'neows', data_as_of: '2026-10-12T10:00:00.000Z', stale: false }),
    ]);
    expect(response.json().data.sources).toContainEqual(expect.objectContaining({ name: 'neows', last_run_status: 'failed' }));
  });

  it('reports a fonte as stale while retaining its last successful instant', async () => {
    await db.insertInto('ingestion_run').values([
      { source: 'neows', status: 'succeeded', finished_at: new Date('2026-10-10T11:59:59Z') },
      { source: 'neows', status: 'failed', finished_at: new Date('2026-10-12T11:00:00Z') },
    ]).execute();

    const response = await app.inject('/v1/status');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta.sources).toContainEqual(expect.objectContaining({
      name: 'neows', data_as_of: '2026-10-10T11:59:59.000Z', stale: true,
    }));
    expect(body.data.sources).toContainEqual(expect.objectContaining({
      name: 'neows', last_run_status: 'failed', last_run_finished_at: '2026-10-12T11:00:00.000Z',
    }));
  });

  it('publishes OpenAPI and documentation without a key', async () => {
    const response = await app.inject('/v1/openapi.json');
    expect(response.statusCode).toBe(200);
    const document = response.json();
    expect(document.openapi).toBe('3.1.0');
    const documentedPaths = [
      '/v1/status', '/v1/openapi.json', '/v1/exoplanets', '/v1/exoplanets/{name}',
      '/v1/exoplanets/{name}/revisions', '/v1/close-approaches',
    ];
    for (const path of documentedPaths) expect(document.paths).toHaveProperty(path);
    const routeStack: string[] = [];
    const registeredApiPaths: string[] = [];
    for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
      const match = /^([│ ]*)[├└]── (.+) \(([^)]+)\)$/.exec(line);
      if (!match || !match[3]!.split(', ').includes('GET')) continue;
      const level = match[1]!.length / 4;
      const path = level === 0 ? match[2]! : `${routeStack[level - 1]}${match[2]}`;
      routeStack[level] = path;
      if (path.startsWith('/v1/')) registeredApiPaths.push(path.replace(/:([^/]+)/g, '{$1}'));
    }
    for (const path of registeredApiPaths) expect(document.paths).toHaveProperty(path);
    expect(document.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    for (const path of ['/v1/exoplanets', '/v1/exoplanets/{name}', '/v1/exoplanets/{name}/revisions', '/v1/close-approaches']) {
      expect(document.paths[path].get.security).toEqual([{ bearerAuth: [] }]);
      expect(document.paths[path].get.responses).toHaveProperty('401');
      expect(document.paths[path].get.responses['200'].headers).toMatchObject({
        ETag: { schema: { type: 'string' } },
        'Cache-Control': { schema: { type: 'string' } },
        'RateLimit-Limit': { schema: { type: 'integer' } },
        'RateLimit-Remaining': { schema: { type: 'integer' } },
        'RateLimit-Reset': { schema: { type: 'integer' } },
      });
      expect(document.paths[path].get.responses['304'].headers).toHaveProperty('ETag');
      for (const status of ['400', '401', '429', '500']) {
        expect(document.paths[path].get.responses[status].content).toHaveProperty('application/problem+json');
      }
      expect(document.paths[path].get.responses['429'].headers).toHaveProperty('Retry-After');
      const errorCodes = document.paths[path].get.responses['500'].content['application/problem+json'].schema.properties.code.anyOf
        .flatMap((option: { enum?: string[] }) => option.enum ?? []);
      expect(errorCodes).toEqual(expect.arrayContaining([
        'invalid_input', 'invalid_cursor', 'invalid_api_key', 'not_found', 'rate_limited', 'internal_error',
      ]));
    }
    expect(document.paths['/v1/status'].get.security).toBeUndefined();
    expect(document.paths['/v1/status'].get.responses['200'].headers).toBeUndefined();
    const docs = await app.inject('/docs');
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-type']).toContain('text/html');
    expect(docs.body).toContain('/v1/openapi.json');
    expect(docs.body).toContain('Authorization: Bearer');
    expect(docs.body).toContain('RateLimit-Limit');
    expect(docs.body).toContain('ETag');
    expect(docs.body).toContain('invalid_cursor');
    expect(docs.body).toContain('This research has made use of the NASA Exoplanet Archive');
    expect(docs.body).toContain('NASA/JPL Center for Near Earth Object Studies (CNEOS)');
  });

  it.each(['/v1/exoplanets', '/v1/exoplanets/HD%202039%20b', '/v1/exoplanets/HD%202039%20b/revisions', '/v1/close-approaches'])('requires a key on %s before processing data', async (url) => {
    const response = await app.inject(url);
    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ code: 'invalid_api_key', title: 'Unauthorized', status: 401 });
  });
});
