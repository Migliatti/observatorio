import { describe, expect, it } from 'vitest';
import { freshness } from './freshness.js';

describe('frescor da fonte', () => {
  const collected = new Date('2026-10-10T12:00:00Z');
  it('keeps data fresh at 48 hours and marks it outdated only after that', () => {
    expect(freshness(collected, new Date('2026-10-12T12:00:00Z'))).toEqual({ data_as_of: '2026-10-10T12:00:00.000Z', stale: false });
    expect(freshness(collected, new Date('2026-10-12T12:00:00.001Z')).stale).toBe(true);
  });
  it('reports missing successful collection honestly', () => {
    expect(freshness(null, collected)).toEqual({ data_as_of: null, stale: true });
  });
});
