import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('rate-limit and CORS configuration', () => {
  it('defaults to the documented policies and converts environment overrides', () => {
    const defaults = loadConfig({ DATABASE_URL: 'postgres://user:pass@localhost/observatorio' });
    expect(defaults).toMatchObject({
      RATE_LIMIT_KEY_CAPACITY: 30,
      RATE_LIMIT_KEY_REFILL_PER_SECOND: 1,
      RATE_LIMIT_IP_CAPACITY: 30,
      RATE_LIMIT_IP_WINDOW_SECONDS: 60,
      CORS_ORIGINS: 'https://kepler-lab-gamma.vercel.app,http://localhost:5173,http://localhost:3000',
      TRUSTED_PROXIES: '',
    });

    const configured = loadConfig({
      DATABASE_URL: 'postgres://user:pass@localhost/observatorio',
      RATE_LIMIT_KEY_CAPACITY: '12',
      RATE_LIMIT_KEY_REFILL_PER_SECOND: '2.5',
      RATE_LIMIT_IP_CAPACITY: '8',
      RATE_LIMIT_IP_WINDOW_SECONDS: '120',
      CORS_ORIGINS: 'https://kepler-lab-gamma.vercel.app,http://localhost:5173',
      TRUSTED_PROXIES: '10.0.0.10,192.168.0.0/24',
    });
    expect(configured).toMatchObject({
      RATE_LIMIT_KEY_CAPACITY: 12,
      RATE_LIMIT_KEY_REFILL_PER_SECOND: 2.5,
      RATE_LIMIT_IP_CAPACITY: 8,
      RATE_LIMIT_IP_WINDOW_SECONDS: 120,
      CORS_ORIGINS: 'https://kepler-lab-gamma.vercel.app,http://localhost:5173',
      TRUSTED_PROXIES: '10.0.0.10,192.168.0.0/24',
    });
  });
});
