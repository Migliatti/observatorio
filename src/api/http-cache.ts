import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const DATA_ROUTES = ['/v1/exoplanets', '/v1/close-approaches'];

interface SourceVersion {
  name: string;
  data_as_of: string | null;
  stale: boolean;
}

function sourceVersions(payload: unknown): SourceVersion[] | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const meta = (payload as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const sources = (meta as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return null;

  const versions: SourceVersion[] = [];
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const item = source as Record<string, unknown>;
    if (typeof item.name !== 'string' || (item.data_as_of !== null && typeof item.data_as_of !== 'string') || typeof item.stale !== 'boolean') return null;
    versions.push({ name: item.name, data_as_of: item.data_as_of, stale: item.stale });
  }
  return versions.toSorted((left, right) => left.name.localeCompare(right.name));
}

function matchesIfNoneMatch(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const candidates = (Array.isArray(header) ? header : [header]).flatMap((value) => value.split(','));
  return candidates.some((candidate) => {
    const tag = candidate.trim();
    return tag === '*' || (tag.startsWith('W/') ? tag.slice(2) : tag) === etag;
  });
}

/** Adds validators to successful data responses, using only the successful source version in meta. */
export function installSourceCache(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    const pathname = request.url.split('?')[0]!;
    if (!DATA_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`))) return payload;
    if (reply.statusCode < 200 || reply.statusCode >= 300 || typeof payload !== 'string') return payload;

    let body: unknown;
    try {
      body = JSON.parse(payload) as unknown;
    } catch {
      return payload;
    }
    const sources = sourceVersions(body);
    if (!sources) return payload;

    const etag = `"${createHash('sha256').update(JSON.stringify({ url: request.url, sources })).digest('base64url')}"`;
    reply.header('Cache-Control', 'private, no-cache');
    reply.header('ETag', etag);
    if (matchesIfNoneMatch(request.headers['if-none-match'], etag)) {
      reply.code(304);
      return '';
    }
    return payload;
  });
}
