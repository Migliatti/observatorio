import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import { sql } from 'kysely';
import { buildApp } from '../api/app.js';
import { exoplanetArchiveCollector } from '../collect/exoplanet-archive.js';
import { runCollection } from '../collect/run.js';
import { createTestDatabase, resetDatabase } from './database.js';

const fixture = readFileSync(new URL('../sources/fixtures/exoplanet-archive/pscomppars.json', import.meta.url), 'utf8');
const firstDay = new Date('2026-10-12T12:00:00Z');

describe('stable exoplaneta pagination across coletas', () => {
  let db: Database;
  let app: FastifyInstance;
  let now: Date;
  beforeAll(async () => {
    db = createTestDatabase();
    app = await buildApp({ db, now: () => now });
    await app.ready();
  });
  beforeEach(async () => { await resetDatabase(db); now = firstDay; });
  afterAll(async () => { await app.close(); await db.destroy(); });
  const collect = (body: string) => runCollection(db, 'exoplanet-archive', exoplanetArchiveCollector({
    fetch: async () => new Response(body),
  }), () => now);

  it('continues the original sorted and filtered catalogue after revisions, removal and insertion', async () => {
    await collect(fixture);
    const url = '/v1/exoplanets?sort=mass_earth_masses&order=desc&mass_earth_masses_min=1000';
    const original = (await app.inject(url)).json();
    expect(original.data.length).toBeGreaterThan(1);
    const first = (await app.inject(`${url}&limit=1`)).json();
    expect(first.meta.updates_available).toBe(false);

    now = new Date('2026-10-13T12:00:00Z');
    const changed = JSON.parse(fixture);
    changed[0].pl_bmasse = 99999;
    changed.splice(1, 1);
    changed.push({ ...changed[0], pl_name: 'New massive b' });
    await collect(JSON.stringify(changed));
    const continuation = await app.inject(`${url}&limit=200&cursor=${first.meta.next_cursor}`);
    expect(continuation.statusCode).toBe(200);
    const remaining = continuation.json();
    expect([...first.data, ...remaining.data]).toEqual(original.data);
    expect(remaining.meta.updates_available).toBe(true);
    expect(remaining.meta.sources[0].data_as_of).toBe(firstDay.toISOString());
    expect(remaining.meta.snapshot_expires_at).toBe(first.meta.snapshot_expires_at);
    const refreshed = (await app.inject(url)).json();
    expect(refreshed.data).not.toEqual(original.data);
    expect(refreshed.meta.updates_available).toBe(false);
    expect(refreshed.meta.sources[0].data_as_of).toBe(now.toISOString());
  });

  it('keeps a fixed navigation deadline, survives an API restart and serves stale catalogues', async () => {
    await collect(fixture);
    const first = (await app.inject('/v1/exoplanets?limit=1')).json();
    now = new Date('2026-10-14T11:00:00Z');
    const restarted = await buildApp({ db, now: () => now });
    try {
      const second = await restarted.inject(`/v1/exoplanets?limit=1&cursor=${first.meta.next_cursor}`);
      expect(second.statusCode).toBe(200);
      expect(second.json().meta.snapshot_expires_at).toBe(first.meta.snapshot_expires_at);
      now = new Date(first.meta.snapshot_expires_at);
      const expired = await restarted.inject(`/v1/exoplanets?limit=1&cursor=${second.json().meta.next_cursor}`);
      expect(expired.statusCode).toBe(400);
      expect(expired.json().code).toBe('invalid_cursor');
      now = new Date('2026-10-15T12:00:00Z');
      const freshNavigation = (await restarted.inject('/v1/exoplanets?limit=1')).json();
      expect(freshNavigation.meta.sources[0].stale).toBe(true);
      expect(freshNavigation.meta.updates_available).toBe(false);
      const next = await restarted.inject(`/v1/exoplanets?limit=1&cursor=${freshNavigation.meta.next_cursor}`);
      expect(next.statusCode).toBe(200);
    } finally {
      await restarted.close();
    }
  });

  it('rejects a cursor whose catalogue or navigation deadline was changed by the consumer', async () => {
    await collect(fixture);
    const first = (await app.inject('/v1/exoplanets?limit=1')).json();
    const [payload, signature] = first.meta.next_cursor.split('.');
    const cursor = JSON.parse(Buffer.from(payload, 'base64url').toString());
    cursor.expires_at -= 1000;
    const altered = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    const response = await app.inject(`/v1/exoplanets?limit=1&cursor=${altered}${signature ? `.${signature}` : ''}`);
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('invalid_cursor');
  });

  it('retires superseded catalogues after 48 hours without deleting permanent revisions', async () => {
    await collect(fixture);
    const first = (await app.inject('/v1/exoplanets?limit=1')).json();
    const originalVersion = JSON.parse(Buffer.from(first.meta.next_cursor.split('.')[0], 'base64url').toString()).catalogue_id;
    now = new Date('2026-10-13T12:00:00Z');
    const changed = JSON.parse(fixture);
    changed[0].pl_bmasse = 500;
    await collect(JSON.stringify(changed));
    expect(await db.selectFrom('exoplanet_catalogue').select('id').where('id', '=', originalVersion).executeTakeFirst()).toBeDefined();
    now = new Date('2026-10-15T12:00:00Z');
    await collect(JSON.stringify(changed));
    expect(await db.selectFrom('exoplanet_catalogue').select('id').where('id', '=', originalVersion).executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('exoplanet_catalogue_item').select('id').where('catalogue_id', '=', originalVersion).execute()).toEqual([]);
    expect(await db.selectFrom('exoplanet_revision').select('id').execute()).toHaveLength(1);
    const latest = await app.inject('/v1/exoplanets');
    expect(latest.statusCode).toBe(200);
    expect(latest.json().data).toHaveLength(5);
    expect(latest.json().meta.updates_available).toBe(false);
  });

  it('rolls back data and catalogue publication together when publication fails', async () => {
    await collect(fixture);
    const before = (await app.inject('/v1/exoplanets')).json();
    const first = (await app.inject('/v1/exoplanets?limit=1')).json();
    now = new Date('2026-10-13T12:00:00Z');
    const changed = JSON.parse(fixture);
    changed[0].pl_bmasse = 500;
    await sql`alter table exoplanet_catalogue add constraint reject_catalogue check (false) not valid`.execute(db);
    try {
      await expect(collect(JSON.stringify(changed))).rejects.toThrow(/reject_catalogue/);
      const continued = (await app.inject(`/v1/exoplanets?limit=200&cursor=${first.meta.next_cursor}`)).json();
      expect([...first.data, ...continued.data]).toEqual(before.data);
      expect(continued.meta.updates_available).toBe(false);
      const latest = (await app.inject('/v1/exoplanets')).json();
      expect(latest.data).toEqual(before.data);
      expect(latest.meta.sources[0].data_as_of).toBe(firstDay.toISOString());
      expect((await db.selectFrom('ingestion_run').select('status').orderBy('id', 'desc').executeTakeFirst())?.status).toBe('failed');
    } finally {
      await sql`alter table exoplanet_catalogue drop constraint reject_catalogue`.execute(db);
    }
  });
});
