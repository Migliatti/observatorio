import type { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../db/database.js';
import { validateTestDatabaseUrl } from './database.js';

const poolInstances = vi.hoisted(() => [] as EventEmitter[]);

vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { EventEmitter } = await import('node:events');
  class FakePool extends EventEmitter {
    constructor() {
      super();
      poolInstances.push(this);
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { ...actual, default: actual, Pool: FakePool };
});

describe('validateTestDatabaseUrl', () => {
  it.each([
    'postgres://u:p@localhost:5432/app_test',
    'postgres://u:p@127.0.0.1:5432/app_test',
    'postgres://u:p@[::1]:5432/app_test',
  ])('accepts local test database %s', (url) => {
    expect(validateTestDatabaseUrl(url, {})).toBe(url);
  });

  it('rejects names without the _test suffix', () => {
    expect(() => validateTestDatabaseUrl('postgres://u:p@localhost:5432/app', {})).toThrow(/_test/);
  });

  it('rejects remote hosts unless explicitly allowed', () => {
    const url = 'postgres://u:p@db.example.com:5432/app_test';
    expect(() => validateTestDatabaseUrl(url, {})).toThrow(/not local/);
    expect(validateTestDatabaseUrl(url, { ALLOW_REMOTE_TEST_DATABASE: '1' })).toBe(url);
  });

  it('gives a clear error for malformed URLs', () => {
    expect(() => validateTestDatabaseUrl('not a url', {})).toThrow(/not a valid URL/);
  });
});

describe('createDatabase', () => {
  it('registers a pool error listener so idle-client errors do not crash the process', async () => {
    const onPoolError = vi.fn<(error: Error) => void>();
    const db = createDatabase('postgres://u:p@localhost:5432/app_test', { onPoolError });
    const pool = poolInstances.at(-1)!;
    expect(pool.listenerCount('error')).toBe(1);
    const error = new Error('connection terminated');
    pool.emit('error', error);
    expect(onPoolError).toHaveBeenCalledWith(error);
    await db.destroy();
  });

  it('logs idle-client errors with console.error by default', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = createDatabase('postgres://u:p@localhost:5432/app_test');
    poolInstances.at(-1)!.emit('error', new Error('boom'));
    expect(spy).toHaveBeenCalledOnce();
    await db.destroy();
  });
});
