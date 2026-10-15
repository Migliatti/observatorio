export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  wait?: (delayMs: number) => Promise<void>;
}

const sleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));

/** Retries a connection operation a bounded number of times using exponential full jitter. */
export async function connectWithRetry<T>(connect: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 1_000;
  const random = options.random ?? Math.random;
  const wait = options.wait ?? sleep;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await connect();
    } catch (error) {
      if (attempt === attempts) throw error;
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await wait(Math.floor(random() * ceiling));
    }
  }
  throw new Error('Connection retry attempts must be greater than zero.');
}
