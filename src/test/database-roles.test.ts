import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from './database.js';

describe('Postgres service roles', () => {
  const client = new Client({ connectionString: testDatabaseUrl() });

  beforeAll(async () => client.connect());
  afterAll(async () => client.end());

  it('lets api read and update only last_used_at, while denying data writes and key deletion', async () => {
    await client.query('SET ROLE api');
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
    await client.query('SET ROLE collector');
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
    const keyHash = 'e'.repeat(64);
    await client.query('DELETE FROM api_key WHERE key_hash = $1', [keyHash]);
    await client.query('SET ROLE key_admin');
    try {
      await expect(client.query(
        'INSERT INTO api_key (key_hash, prefix, consumer) VALUES ($1, $2, $3) RETURNING id',
        [keyHash, 'obs_test', 'role test'],
      )).resolves.toBeDefined();
      await expect(client.query('SELECT id FROM api_key WHERE key_hash = $1', [keyHash])).resolves.toBeDefined();
      await expect(client.query('UPDATE api_key SET revoked_at = now() WHERE key_hash = $1', [keyHash])).resolves.toBeDefined();
      await expect(client.query('DELETE FROM api_key WHERE key_hash = $1', [keyHash])).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('RESET ROLE');
      await client.query('DELETE FROM api_key WHERE key_hash = $1', [keyHash]);
    }
  });
});
