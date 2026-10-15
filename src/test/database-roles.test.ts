import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, resetDatabase, testDatabaseUrl } from './database.js';

describe('Postgres service roles', () => {
  const client = new Client({ connectionString: testDatabaseUrl() });
  const cleanupDb = createTestDatabase();

  beforeAll(async () => client.connect());
  beforeEach(async () => resetDatabase(cleanupDb));
  afterAll(async () => {
    await client.end();
    await cleanupDb.destroy();
  });

  it('lets api read and update only last_used_at, while denying data writes and key deletion', async () => {
    await client.query('SET ROLE observatorio_api');
    try {
      await expect(client.query('SELECT id, key_hash FROM api_key')).resolves.toBeDefined();
      await expect(client.query('UPDATE api_key SET last_used_at = now() WHERE false')).resolves.toBeDefined();
      await expect(client.query('UPDATE api_key SET revoked_at = now() WHERE false')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query("INSERT INTO ingestion_run (source) VALUES ('neows')")).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('DELETE FROM api_key WHERE false')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('CREATE TABLE public.api_role_probe (id integer)')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('ALTER TABLE public.ingestion_run ADD COLUMN api_role_probe integer')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('RESET ROLE');
    }
  });

  it('lets collector write collection data but denies schema changes and api-key writes', async () => {
    await client.query('SET ROLE observatorio_collector');
    try {
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO ingestion_run (source) VALUES ('neows') RETURNING id",
      );
      const id = inserted.rows[0]!.id;
      await expect(client.query("UPDATE ingestion_run SET status = 'failed' WHERE id = $1", [id])).resolves.toBeDefined();
      await expect(client.query('DELETE FROM ingestion_run WHERE id = $1', [id])).resolves.toBeDefined();
      await expect(client.query("INSERT INTO api_key (key_hash, prefix, consumer) VALUES (repeat('a', 64), 'obs_test', 'test')"))
        .rejects.toMatchObject({ code: '42501' });
      await expect(client.query('CREATE TABLE public.collector_role_probe (id integer)')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('ALTER TABLE public.ingestion_run ADD COLUMN collector_role_probe integer')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('RESET ROLE');
    }
  });

  it('lets key_admin create, read, and revoke keys without deleting them', async () => {
    await client.query('SET ROLE observatorio_key_admin');
    try {
      await expect(client.query('SELECT key_hash FROM api_key')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('SELECT last_value FROM api_key_id_seq')).rejects.toMatchObject({ code: '42501' });
      const created = await client.query<{ id: string }>(
        `INSERT INTO api_key (key_hash, prefix, consumer)
         VALUES (repeat('e', 64), 'obs_test', 'role test')
         RETURNING id, prefix, consumer, created_at, revoked_at, last_used_at`,
      );
      const id = created.rows[0]!.id;
      await expect(client.query(
        'SELECT id, prefix, consumer, created_at, revoked_at, last_used_at FROM api_key ORDER BY id',
      )).resolves.toBeDefined();
      await expect(client.query('UPDATE api_key SET revoked_at = now() WHERE id = $1', [id])).resolves.toBeDefined();
      await expect(client.query('DELETE FROM api_key WHERE id = $1', [id])).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('RESET ROLE');
    }
  });
});
