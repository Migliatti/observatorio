import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import { buildApp } from './app.js';

describe('request logs', () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const secretKey = `obs_${'a'.repeat(43)}`;
  const errorSecret = 'sentinel-secret-credential';
  const database = {
    selectFrom() {
      const query = {
        select() { return query; },
        where() { return query; },
        executeTakeFirst: async () => ({
          id: '123456789', consumer: 'log test', last_used_at: new Date('2026-10-15T12:00:00Z'),
        }),
      };
      return query;
    },
  } as unknown as Database;
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      db: database,
      now: () => new Date('2026-10-15T12:00:00Z'),
      logger: { level: 'info', stream },
    });
    app.get('/v1/__test/:id', async (_request, reply) => reply.code(304).send());
    app.get('/v1/__test-error/:id', async () => {
      throw Object.assign(new Error(`private handler failure: ${errorSecret}\n    at Object.leak (${errorSecret}.ts:999:1)`), {
        authorization: `Bearer ${errorSecret}`,
        apiKey: errorSecret,
      });
    });
    await app.ready();
    lines.length = 0;
  });
  afterAll(async () => app.close());

  it('emits one safe structured completion line with route template and short key id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/__test/private-value?api_key=obs_query_secret&Authorization=Bearer%20query_secret',
      headers: { authorization: `Bearer ${secretKey}` },
      remoteAddress: '203.0.113.42',
    });

    expect(response.statusCode).toBe(304);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({
      method: 'GET', route: '/v1/__test/:id', statusCode: 304, notModified: true, keyId: '456789',
    });
    expect(entry.responseTimeMs).toEqual(expect.any(Number));
    expect(lines.join('')).not.toContain(secretKey);
    expect(lines.join('')).not.toContain('Bearer');
    expect(lines.join('')).not.toContain('203.0.113.42');
    expect(lines.join('')).not.toContain('private-value');
    expect(lines.join('')).not.toContain('query_secret');
  });

  it('includes a stable problem code when a request fails', async () => {
    lines.length = 0;
    const response = await app.inject({
      method: 'GET',
      url: '/v1/__test-error/private-value',
      headers: { authorization: `Bearer ${secretKey}` },
    });

    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ code: 'internal_error' });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({
      statusCode: 500,
      problemCode: 'internal_error',
      errorType: 'Error',
      stackFrames: expect.stringMatching(/request-logs\.test\.ts:\d+/),
    });
    expect(lines.join('')).not.toContain(secretKey);
    expect(lines.join('')).not.toContain('Bearer');
    expect(lines.join('')).not.toContain(errorSecret);
  });
});
