import { describe, expect, it } from 'vitest';
import { consumeRequestWindow, consumeToken, type TokenBucket } from './rate-limit.js';

describe('consumeToken', () => {
  it('starts full, consumes one token, and rejects when the bucket is empty', () => {
    let bucket: TokenBucket | undefined;
    for (let request = 0; request < 30; request++) {
      const result = consumeToken(bucket, 0, 30, 1);
      expect(result.allowed).toBe(true);
      bucket = result.bucket;
    }

    const limited = consumeToken(bucket, 0, 30, 1);
    expect(limited.allowed).toBe(false);
    expect(limited.remaining).toBe(0);
    expect(limited.retryAfterSeconds).toBe(1);
  });

  it('refills from the injected clock and caps at capacity', () => {
    const empty: TokenBucket = { tokens: 0, updatedAt: 1_000 };
    const refilled = consumeToken(empty, 2_000, 30, 1);
    expect(refilled.allowed).toBe(true);
    expect(refilled.bucket.tokens).toBe(0);

    const full = consumeToken(undefined, 2_000, 30, 1);
    const capped = consumeToken(full.bucket, 62_000, 30, 1);
    expect(capped.bucket.tokens).toBe(29);
    expect(capped.remaining).toBe(29);
  });
});

describe('consumeRequestWindow', () => {
  it('enforces a rolling request window before admitting another request', () => {
    const first = consumeRequestWindow(undefined, 0, 2, 60);
    const second = consumeRequestWindow(first.requests, 1_000, 2, 60);
    const limited = consumeRequestWindow(second.requests, 59_999, 2, 60);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(limited.allowed).toBe(false);
    expect(limited.remaining).toBe(0);
    expect(limited.retryAfterSeconds).toBe(1);

    const refilled = consumeRequestWindow(limited.requests, 60_000, 2, 60);
    expect(refilled.allowed).toBe(true);
    expect(refilled.remaining).toBe(0);
  });
});
