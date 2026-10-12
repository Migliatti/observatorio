import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, resetDatabase, testDatabaseUrl } from './database.js';
import { main } from '../keys/main.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../db/api-key.js';
import Fastify from 'fastify';
import { installApiKeyAuth } from '../api/auth.js';
import { buildApp } from '../api/app.js';

const db = createTestDatabase();
afterAll(() => db.destroy());
beforeEach(() => resetDatabase(db));
describe('API key lifecycle through the CLI', () => {
  it('creates a secret once and lists only its safe metadata', async () => {
    const output: string[] = [];
    const deps = { databaseUrl: testDatabaseUrl(), log: (line: string) => output.push(line), logError: (line: string) => output.push(line) };
    expect(await main(['create', 'test consumer'], deps)).toBe(0);
    const created = JSON.parse(output.shift()!);
    expect(created.key).toMatch(/^obs_[A-Za-z0-9_-]{43}$/);
    expect(created.consumer).toBe('test consumer');
    expect(await main(['list'], deps)).toBe(0);
    expect(output.join('')).not.toContain(created.key);
    const keys = await listApiKeys(db);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.prefix).toBe(created.key.slice(0, 12));
    expect(keys[0]?.revoked_at).toBeNull();
  });
});


it('protects data routes and bounds revocation caching to 60 seconds', async () => {
  let time = new Date('2026-01-01T00:00:00Z');
  const app = Fastify();
  app.decorate('db', db);
  app.decorate('now', () => time);
  installApiKeyAuth(app);
  app.get('/v1/exoplanets', () => ({ data: [] }));
  app.get('/v1/status', () => ({ ok: true }));
  try {
    const missing = await app.inject('/v1/exoplanets');
    expect(missing.statusCode).toBe(401);
    expect(missing.json().code).toBe('invalid_api_key');
    expect(missing.headers['content-type']).toContain('application/problem+json');
    expect((await app.inject('/v1/status')).statusCode).toBe(200);
    const key = await createApiKey(db, 'kepler-lab', time);
    const request = () => app.inject({ url: '/v1/exoplanets', headers: { authorization: `Bearer ${key.key}` } });
    expect((await request()).statusCode).toBe(200);
    await revokeApiKey(db, key.id, time);
    expect((await request()).statusCode).toBe(200);
    time = new Date(time.getTime() + 60_000);
    expect((await request()).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/exoplanets', headers: { authorization: 'Bearer obs_invalid' } })).statusCode).toBe(401);
  } finally {
    await app.close();
  }
});

it('revokes a key through the CLI and never emits its secret again', async () => {
  const key = await createApiKey(db, 'consumer');
  const output: string[] = [];
  const deps = { databaseUrl: testDatabaseUrl(), log: (line: string) => output.push(line), logError: (line: string) => output.push(line) };
  expect(await main(['revoke', key.id], deps)).toBe(0);
  expect(await main(['list'], deps)).toBe(0);
  expect(JSON.parse(output[1]!)[0].revoked_at).not.toBeNull();
  expect(output.join('')).not.toContain(key.key);
  expect(await main(['revoke', key.id], deps)).toBe(1);
  expect(await main(['create', ' '], deps)).toBe(1);
});

it('updates last-used at most once per five minutes, including across cache refreshes', async () => {
  let time = new Date('2026-01-01T00:00:00Z');
  const app = Fastify();
  app.decorate('db', db);
  app.decorate('now', () => time);
  installApiKeyAuth(app);
  app.get('/v1/close-approaches', () => ({ data: [] }));
  const key = await createApiKey(db, 'kepler-lab', time);
  const request = () => app.inject({ url: '/v1/close-approaches', headers: { authorization: `Bearer ${key.key}` } });
  try {
    expect((await request()).statusCode).toBe(200);
    const first = (await listApiKeys(db))[0]!.last_used_at;
    expect(first?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    time = new Date('2026-01-01T00:04:59Z');
    expect((await request()).statusCode).toBe(200);
    expect((await listApiKeys(db))[0]!.last_used_at).toEqual(first);
    time = new Date('2026-01-01T00:05:00Z');
    expect((await request()).statusCode).toBe(200);
    expect((await listApiKeys(db))[0]!.last_used_at?.toISOString()).toBe('2026-01-01T00:05:00.000Z');
  } finally {
    await app.close();
  }
});


it('requires keys on every registered data route and keeps documentation public', async () => {
  const app = await buildApp({ db });
  try {
    for (const url of ['/v1/exoplanets', '/v1/exoplanets/Earth', '/v1/exoplanets/Earth/revisions', '/v1/close-approaches']) {
      const result = await app.inject(url);
      expect(result.statusCode).toBe(401);
      expect(result.json().code).toBe('invalid_api_key');
    }
    for (const url of ['/v1/status', '/v1/openapi.json', '/docs']) {
      expect((await app.inject(url)).statusCode).toBe(200);
    }
    const document = (await app.inject('/v1/openapi.json')).json();
    expect(document.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
    expect(document.paths['/v1/exoplanets'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/v1/exoplanets'].get.responses['401']).toBeDefined();
  } finally {
    await app.close();
  }
});
