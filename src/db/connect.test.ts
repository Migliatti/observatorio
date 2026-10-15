import { describe, expect, it, vi } from 'vitest';
import { connectWithRetry } from './connect.js';

describe('connectWithRetry', () => {
  it('retries transient failures up to five attempts with jittered waits', async () => {
    const connect = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('third'))
      .mockResolvedValue('connected');
    const wait = vi.fn<(_: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(connectWithRetry(connect, { random: () => 0.5, wait })).resolves.toBe('connected');

    expect(connect).toHaveBeenCalledTimes(4);
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([50, 100, 200]);
  });

  it('stops after five attempts and propagates the final connection error', async () => {
    const connect = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('unavailable'));
    const wait = vi.fn<(_: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(connectWithRetry(connect, { random: () => 1, wait })).rejects.toThrow('unavailable');

    expect(connect).toHaveBeenCalledTimes(5);
    expect(wait).toHaveBeenCalledTimes(4);
  });
});
