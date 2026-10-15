import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const VALID_URL = 'postgres://observatorio_api:secret@localhost:5432/observatorio';

describe('loadConfig', () => {
  it('applies defaults and converts numbers', () => {
    expect(loadConfig({ API_DATABASE_URL: VALID_URL, PORT: '8080' })).toEqual({
      API_DATABASE_URL: VALID_URL,
      PORT: 8080,
      HOST: '0.0.0.0',
      LOG_LEVEL: 'info',
      RATE_LIMIT_KEY_CAPACITY: 30,
      RATE_LIMIT_KEY_REFILL_PER_SECOND: 1,
      RATE_LIMIT_IP_CAPACITY: 30,
      RATE_LIMIT_IP_WINDOW_SECONDS: 60,
      CORS_ORIGINS: 'https://kepler-lab-gamma.vercel.app,http://localhost:5173,http://localhost:3000',
      TRUSTED_PROXIES: '',
    });
  });

  it('converts configurable rate limits and keeps CORS origins as a comma-separated list', () => {
    expect(loadConfig({
      API_DATABASE_URL: VALID_URL,
      RATE_LIMIT_KEY_CAPACITY: '12',
      RATE_LIMIT_KEY_REFILL_PER_SECOND: '2.5',
      RATE_LIMIT_IP_CAPACITY: '9',
      RATE_LIMIT_IP_WINDOW_SECONDS: '120',
      CORS_ORIGINS: 'https://kepler-lab-gamma.vercel.app,http://localhost:5173',
      TRUSTED_PROXIES: '10.0.0.10,192.168.0.0/24',
    })).toMatchObject({
      RATE_LIMIT_KEY_CAPACITY: 12,
      RATE_LIMIT_KEY_REFILL_PER_SECOND: 2.5,
      RATE_LIMIT_IP_CAPACITY: 9,
      RATE_LIMIT_IP_WINDOW_SECONDS: 120,
      CORS_ORIGINS: 'https://kepler-lab-gamma.vercel.app,http://localhost:5173',
      TRUSTED_PROXIES: '10.0.0.10,192.168.0.0/24',
    });
  });

  it('lists every problem in one clear error', () => {
    expect(() => loadConfig({ PORT: 'abc', LOG_LEVEL: 'loud' })).toThrow(
      new ConfigError([
        'API_DATABASE_URL is required',
        'PORT must be integer (received "abc")',
        'LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent (received "loud")',
      ]),
    );
  });

  it('never echoes the database URL, which carries credentials', () => {
    expect(() => loadConfig({ API_DATABASE_URL: 'mysql://user:secret@host/db' })).toThrow(
      /^(?![\s\S]*secret)[\s\S]*API_DATABASE_URL must match pattern/,
    );
  });
});

describe('API boot', () => {
  it('refuses to start with invalid configuration', async () => {
    const server = fileURLToPath(new URL('./server.ts', import.meta.url));
    const run = promisify(execFile)(process.execPath, ['--import', 'tsx', server], {
      env: { ...process.env, API_DATABASE_URL: '', PORT: 'not-a-port' },
      timeout: 20_000,
    });

    await expect(run).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Invalid configuration'),
    });
  });
});
