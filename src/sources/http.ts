// Minimal HTTP helper for the fontes: native fetch with a per-attempt timeout and
// retry with exponential backoff. No HTTP library by design.

export type Fetch = typeof fetch;

export interface HttpOptions {
  /** fetch implementation; tests inject one that serves recorded fixtures. Defaults to the global fetch. */
  fetch?: Fetch;
  /** Total attempts, including the first one. Defaults to 3. */
  attempts?: number;
  /** Timeout for each attempt (request and body), in milliseconds. Defaults to 60 s. */
  timeoutMs?: number;
  /** Delay before the second attempt; doubles on each retry. Defaults to 1 s. */
  baseDelayMs?: number;
  /** Waits between attempts. Injectable so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export class HttpError extends Error {
  readonly status: number;

  constructor(url: string, status: number, body: string) {
    super(`GET ${redact(url)} failed with HTTP ${status}${body ? `: ${snippet(body)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retries network errors, timeouts, HTTP 429 and 5xx. Other HTTP errors fail at once. */
function isRetryable(error: unknown): boolean {
  return !(error instanceof HttpError) || error.status === 429 || error.status >= 500;
}

/**
 * GETs `url` and returns the response body as text, retrying transient failures with
 * exponential backoff (baseDelayMs, 2 × baseDelayMs, ...). Throws the last error when every attempt fails.
 */
export async function getText(url: string, options: HttpOptions = {}): Promise<string> {
  const doFetch = options.fetch ?? fetch;
  const attempts = Math.max(1, options.attempts ?? 3);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const body = await response.text();
      if (!response.ok) throw new HttpError(url, response.status, body);
      return body;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) break;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  if (lastError instanceof HttpError) throw lastError;
  const reason = lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : String(lastError);
  throw new Error(`GET ${redact(url)} failed after ${attempts} attempt(s) (${reason})`, { cause: lastError });
}

/** Keeps error messages short and free of query strings (which may carry API keys). */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<invalid url>';
  }
}

export function snippet(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}
