// Main test seam: the API driven by request injection against the real Postgres.
// The route below exists only in this test; it proves the app reaches the database
// through its `db` dependency and that tests are isolated from each other.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import { createTestDatabase, resetDatabase } from '../test/database.js';
import { buildApp } from './app.js';

describe('API against real Postgres', () => {
  let db: Database;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = createTestDatabase();
    app = await buildApp({ db });
    app.post('/__test/ingestion-runs', async (_request, reply) => {
      const run = await app.db
        .insertInto('ingestion_run')
        .values({ source: 'neows' })
        .returning(['id', 'source', 'status'])
        .executeTakeFirstOrThrow();
      return reply.code(201).send(run);
    });
    app.get('/__test/ingestion-runs', async () =>
      app.db.selectFrom('ingestion_run').select(['id', 'source']).orderBy('id').execute(),
    );
    await app.ready();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('writes and reads through the database', async () => {
    const created = await app.inject({ method: 'POST', url: '/__test/ingestion-runs' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ id: '1', source: 'neows', status: 'running' });

    const listed = await app.inject({ method: 'GET', url: '/__test/ingestion-runs' });
    expect(listed.json()).toEqual([{ id: '1', source: 'neows' }]);
  });

  it('starts every test from an empty database', async () => {
    const listed = await app.inject({ method: 'GET', url: '/__test/ingestion-runs' });
    expect(listed.json()).toEqual([]);

    const created = await app.inject({ method: 'POST', url: '/__test/ingestion-runs' });
    // Identity sequences restart too, so ids are predictable in every test.
    expect(created.json()).toMatchObject({ id: '1' });
  });
});
