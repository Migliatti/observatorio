import { describe, expect, it } from 'vitest';
import { getText, HttpError, type Fetch } from './http.js';

const URL = 'https://example.test/data?api_key=secret';

/** A fetch that answers each call with the next scripted outcome. */
function scriptedFetch(outcomes: Array<Response | Error>): Fetch & { calls: number } {
  const fake = Object.assign(
    async () => {
      const outcome = outcomes[fake.calls++];
      if (!outcome) throw new Error('unexpected extra call');
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    { calls: 0 },
  );
  return fake;
}

function recordingSleep(): ((ms: number) => Promise<void>) & { delays: number[] } {
  const delays: number[] = [];
  return Object.assign(async (ms: number) => void delays.push(ms), { delays });
}

describe('getText', () => {
  it('returns the body of a successful response', async () => {
    const fetch = scriptedFetch([new Response('hello')]);
    await expect(getText(URL, { fetch })).resolves.toBe('hello');
    expect(fetch.calls).toBe(1);
  });

  it('retries server errors and network failures with exponential backoff', async () => {
    const fetch = scriptedFetch([new Response('down', { status: 503 }), new TypeError('fetch failed'), new Response('ok')]);
    const sleep = recordingSleep();
    await expect(getText(URL, { fetch, sleep, baseDelayMs: 100 })).resolves.toBe('ok');
    expect(fetch.calls).toBe(3);
    expect(sleep.delays).toEqual([100, 200]);
  });

  it('gives up after 3 attempts with the last error', async () => {
    const fetch = scriptedFetch([
      new Response('a', { status: 500 }),
      new Response('b', { status: 502 }),
      new Response('c', { status: 504 }),
    ]);
    const error = await getText(URL, { fetch, sleep: recordingSleep() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(504);
    expect(fetch.calls).toBe(3);
    // Query strings may carry API keys and never reach error messages.
    expect((error as Error).message).not.toContain('secret');
  });

  it('does not retry client errors other than 429', async () => {
    const fetch = scriptedFetch([new Response('bad query', { status: 400 })]);
    await expect(getText(URL, { fetch, sleep: recordingSleep() })).rejects.toThrow(/HTTP 400: bad query/);
    expect(fetch.calls).toBe(1);
  });

  it('retries 429', async () => {
    const fetch = scriptedFetch([new Response('slow down', { status: 429 }), new Response('ok')]);
    await expect(getText(URL, { fetch, sleep: recordingSleep() })).resolves.toBe('ok');
  });

  it('aborts an attempt that exceeds the timeout', async () => {
    let calls = 0;
    const hanging: Fetch = (_input, init) => {
      calls++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    };
    await expect(getText(URL, { fetch: hanging, timeoutMs: 10, sleep: recordingSleep() })).rejects.toThrow(
      /failed after 3 attempt\(s\) \(TimeoutError/,
    );
    expect(calls).toBe(3);
  });
});
