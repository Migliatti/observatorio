import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const VALID_URL = 'postgres://user:secret@localhost:5432/observatorio';

describe('loadConfig', () => {
  it('applies defaults and converts numbers', () => {
    expect(loadConfig({ DATABASE_URL: VALID_URL, PORT: '8080' })).toEqual({
      DATABASE_URL: VALID_URL,
      PORT: 8080,
      HOST: '0.0.0.0',
      LOG_LEVEL: 'info',
    });
  });

  it('lists every problem in one clear error', () => {
    expect(() => loadConfig({ PORT: 'abc', LOG_LEVEL: 'loud' })).toThrow(
      new ConfigError([
        'DATABASE_URL is required',
        'PORT must be integer (received "abc")',
        'LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent (received "loud")',
      ]),
    );
  });

  it('never echoes the database URL, which carries credentials', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://user:secret@host/db' })).toThrow(
      /^(?![\s\S]*secret)[\s\S]*DATABASE_URL must match pattern/,
    );
  });
});

describe('API boot', () => {
  it('refuses to start with invalid configuration', async () => {
    const server = fileURLToPath(new URL('./server.ts', import.meta.url));
    const run = promisify(execFile)(process.execPath, ['--import', 'tsx', server], {
      env: { ...process.env, DATABASE_URL: '', PORT: 'not-a-port' },
      timeout: 20_000,
    });

    await expect(run).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Invalid configuration'),
    });
  });
});
