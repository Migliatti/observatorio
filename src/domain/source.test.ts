import { describe, expect, it } from 'vitest';
import { isSource } from './source.js';

describe('isSource', () => {
  it('accepts the v1 fontes', () => {
    expect(isSource('exoplanet-archive')).toBe(true);
    expect(isSource('neows')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isSource('nasa')).toBe(false);
  });
});
