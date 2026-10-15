import type { FastifyInstance, FastifyReply } from 'fastify';
import { isDataRoute } from './auth.js';
import { problem } from './problem.js';

const MAX_BUCKETS = 10_000;

export interface TokenBucket {
  tokens: number;
  updatedAt: number;
}

export interface TokenBucketResult {
  bucket: TokenBucket;
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  resetAfterSeconds: number;
}

export interface RatePolicy {
  capacity: number;
  refillPerSecond: number;
}

export interface RateLimitPolicies {
  ip: RequestWindowPolicy;
  apiKey: RatePolicy;
}

export interface RequestWindowPolicy {
  capacity: number;
  windowSeconds: number;
}

export interface RequestWindowResult {
  requests: number[];
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  resetAfterSeconds: number;
}

/** Pure token-bucket transition. `now` is milliseconds from an injected clock. */
export function consumeToken(
  previous: TokenBucket | undefined,
  now: number,
  capacity: number,
  refillPerSecond: number,
): TokenBucketResult {
  const elapsed = previous ? Math.max(0, now - previous.updatedAt) : 0;
  const available = Math.min(capacity, (previous?.tokens ?? capacity) + elapsed * refillPerSecond / 1000);
  const allowed = available >= 1;
  const tokens = allowed ? available - 1 : available;
  const bucket = { tokens, updatedAt: Math.max(now, previous?.updatedAt ?? now) };
  const retryAfterSeconds = allowed ? 0 : Math.ceil((1 - available) / refillPerSecond);
  const resetAfterSeconds = Math.ceil((capacity - tokens) / refillPerSecond);

  return { bucket, allowed, remaining: Math.floor(tokens), retryAfterSeconds, resetAfterSeconds };
}

/** Pure sliding-window counter. `now` is milliseconds from an injected clock. */
export function consumeRequestWindow(
  previous: number[] | undefined,
  now: number,
  capacity: number,
  windowSeconds: number,
): RequestWindowResult {
  const windowMs = windowSeconds * 1000;
  const requests = (previous ?? []).filter((timestamp) => timestamp > now - windowMs);
  const allowed = requests.length < capacity;
  const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil((requests[0]! + windowMs - now) / 1000));
  if (allowed) requests.push(now);
  const resetAfterSeconds = Math.max(1, Math.ceil(((requests[0] ?? now) + windowMs - now) / 1000));
  return { requests, allowed, remaining: Math.max(0, capacity - requests.length), retryAfterSeconds, resetAfterSeconds };
}

function setBucket(buckets: Map<string, TokenBucket>, key: string, bucket: TokenBucket): void {
  if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value!);
  buckets.set(key, bucket);
}

function limit(
  app: FastifyInstance,
  reply: FastifyReply,
  buckets: Map<string, TokenBucket>,
  key: string,
  policy: RatePolicy,
): boolean {
  const result = consumeToken(buckets.get(key), app.now().getTime(), policy.capacity, policy.refillPerSecond);
  setBucket(buckets, key, result.bucket);
  reply
    .header('RateLimit-Limit', policy.capacity)
    .header('RateLimit-Remaining', result.remaining)
    .header('RateLimit-Reset', result.resetAfterSeconds);
  if (result.allowed) return true;

  reply.header('Retry-After', Math.max(1, result.retryAfterSeconds));
  problem(reply, 429, 'rate_limited', 'The request rate limit has been reached.');
  return false;
}

/** Counts data requests from each IP before API-key authentication. */
export function installIpRateLimit(app: FastifyInstance, policy: RequestWindowPolicy): void {
  const requestsByIp = new Map<string, number[]>();
  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0]!;
    if (!isDataRoute(pathname)) return;
    const previous = requestsByIp.get(request.ip);
    const result = consumeRequestWindow(previous, app.now().getTime(), policy.capacity, policy.windowSeconds);
    if (!requestsByIp.has(request.ip) && requestsByIp.size >= MAX_BUCKETS) requestsByIp.delete(requestsByIp.keys().next().value!);
    requestsByIp.set(request.ip, result.requests);
    reply
      .header('RateLimit-Limit', policy.capacity)
      .header('RateLimit-Remaining', result.remaining)
      .header('RateLimit-Reset', result.resetAfterSeconds);
    if (!result.allowed) {
      reply.header('Retry-After', result.retryAfterSeconds);
      return problem(reply, 429, 'rate_limited', 'The request rate limit has been reached.');
    }
  });
}

/** Counts successful API-key-authenticated requests, including responses later changed to 304. */
export function installApiKeyRateLimit(app: FastifyInstance, policy: RatePolicy): void {
  const buckets = new Map<string, TokenBucket>();
  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0]!;
    if (!isDataRoute(pathname) || !request.apiKey) return;
    if (!limit(app, reply, buckets, request.apiKey.id, policy)) return reply;
  });
}
