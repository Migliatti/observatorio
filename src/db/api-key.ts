import { createHash, randomBytes } from 'node:crypto';
import type { Database } from './database.js';

const metadata = ['id', 'prefix', 'consumer', 'created_at', 'revoked_at', 'last_used_at'] as const;

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** The plaintext key is returned only here; it is never stored. */
export async function createApiKey(db: Database, consumer: string, now = new Date()) {
  if (!consumer.trim()) throw new Error('Consumer must not be empty.');
  const key = `obs_${randomBytes(32).toString('base64url')}`;
  const record = await db.insertInto('api_key').values({
    key_hash: hashApiKey(key), prefix: key.slice(0, 12), consumer: consumer.trim(), created_at: now,
  }).returning(metadata).executeTakeFirstOrThrow();
  return { key, ...record };
}

export function listApiKeys(db: Database) {
  return db.selectFrom('api_key').select(metadata).orderBy('id').execute();
}

export async function revokeApiKey(db: Database, id: string, now = new Date()): Promise<boolean> {
  const result = await db.updateTable('api_key').set({ revoked_at: now }).where('id', '=', id)
    .where('revoked_at', 'is', null).executeTakeFirst();
  return result.numUpdatedRows > 0n;
}
