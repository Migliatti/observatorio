import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import { createApiKey } from '../db/api-key.js';
import { buildApp } from '../api/app.js';
import { neoWsCollector } from '../collect/neows.js';
import { runCollection } from '../collect/run.js';
import { createTestDatabase, resetDatabase } from './database.js';

let db: Database;
let app: FastifyInstance;
let clock: Date;
beforeAll(async () => { db = createTestDatabase(); app = await buildApp({ db, now: () => clock }); await app.ready(); });
beforeEach(async () => { await resetDatabase(db); clock = new Date('2026-10-12T23:59:59Z'); });
afterAll(async () => { await app.close(); await db.destroy(); });
it('retains the successful requested feed window even with no approaches, midnight crossing or later failure', async () => {
  const { key } = await createApiKey(db, 'coverage test', clock);
  const request = () => app.inject({ url: '/v1/close-approaches?from=2026-11-01&to=2026-11-05', headers: { authorization: `Bearer ${key}` } });
  const urls: string[] = [];
  await runCollection(db, 'neows', neoWsCollector('fixture-key', () => clock, { fetch: async (url) => {
    urls.push(String(url)); clock = new Date('2026-10-13T00:00:01Z');
    return new Response(JSON.stringify({ near_earth_objects: {} }));
  } }), () => clock);
  expect(new URL(urls[0]!).searchParams.get('start_date')).toBe('2026-10-12');
  expect(new URL(urls[0]!).searchParams.get('end_date')).toBe('2026-10-18');
  const successful = await request();
  expect(successful.statusCode).toBe(200); expect(successful.json().data).toEqual([]);
  expect(successful.json().meta.coverage).toEqual({ from: '2026-10-12', to: '2026-10-18' });
  clock = new Date('2026-11-01T12:00:00Z');
  await expect(runCollection(db, 'neows', neoWsCollector('fixture-key', () => clock, {
    fetch: async () => new Response('failed', { status: 400 }),
  }), () => clock)).rejects.toThrow('HTTP 400');
  expect((await request()).json().meta.coverage).toEqual({ from: '2026-10-12', to: '2026-10-18' });
});
