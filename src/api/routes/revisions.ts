import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { Type, type Static } from 'typebox';
import { EXOPLANET_PARAMETER_FIELDS, type ExoplanetParameters } from '../../domain/exoplanet.js';
import { changedFields } from '../../domain/revision.js';
import { problem, problemSchema } from '../problem.js';
import { metaSchema, sourceMeta } from '../source-meta.js';
import { exoplanetSchema } from './exoplanets.js';

const nullableString = Type.Union([Type.String(), Type.Null()]);
const querySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  cursor: Type.Optional(Type.String({ maxLength: 4096 })),
  include_removed: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const revisionSchema = Type.Object({
  id: Type.String(), parameters: Type.Pick(exoplanetSchema, [...EXOPLANET_PARAMETER_FIELDS]),
  recorded_at: Type.String({ format: 'date-time' }), changed_fields: Type.Array(Type.Union(EXOPLANET_PARAMETER_FIELDS.map((field) => Type.Literal(field)))),
});

// Process-local signing intentionally invalidates cursors after a restart.
const cursorKey = randomBytes(32);
const cursorLifetimeMs = 48 * 60 * 60 * 1000;
interface Cursor { version: 1; planet_id: string; include_removed: boolean; watermark: string; id: string; recorded_at: string; expires_at: number }
const validId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
function encodeCursor(cursor: Cursor): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${payload}.${createHmac('sha256', cursorKey).update(payload).digest('base64url')}`;
}
function decodeCursor(encoded: string, planetId: string, includeRemoved: boolean, now: Date): Cursor | null {
  try {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(encoded)) return null;
    const [payload, signature] = encoded.split('.') as [string, string];
    const received = Buffer.from(signature, 'base64url');
    const expected = createHmac('sha256', cursorKey).update(payload).digest();
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
    const decoded = Buffer.from(payload, 'base64url');
    if (decoded.toString('base64url') !== payload) return null;
    const item = JSON.parse(decoded.toString('utf8')) as Cursor;
    if (!item || Object.keys(item).toSorted().join(',') !== 'expires_at,id,include_removed,planet_id,recorded_at,version,watermark' || item.version !== 1 || item.planet_id !== planetId || item.include_removed !== includeRemoved || !validId(item.watermark) || !validId(item.id) || BigInt(item.id) > BigInt(item.watermark)) return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(item.recorded_at) || !Number.isFinite(Date.parse(item.recorded_at))) return null;
    if (!Number.isSafeInteger(item.expires_at) || item.expires_at <= now.getTime() || item.expires_at > now.getTime() + cursorLifetimeMs) return null;
    return item;
  } catch { return null; }
}

export async function revisionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { name: string }; Querystring: Static<typeof querySchema> }>('/v1/exoplanets/:name/revisions', {
    schema: { tags: ['Exoplanets'], summary: 'List historical parameter snapshots, newest first',
      params: Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }) }), querystring: querySchema,
      response: { 200: Type.Object({ data: Type.Array(revisionSchema), meta: Type.Object({ ...metaSchema.properties, next_cursor: nullableString }) }), 400: problemSchema, 404: problemSchema },
    },
  }, async (request, reply) => app.db.transaction().setIsolationLevel('repeatable read').execute(async (db) => {
    let planetQuery = db.selectFrom('exoplanet').select('id').where('name', '=', request.params.name);
    if (!request.query.include_removed) planetQuery = planetQuery.where('removed_at', 'is', null);
    const planet = await planetQuery.executeTakeFirst();
    if (!planet) return problem(reply, 404, 'not_found', 'The exoplanet was not found.');
    const now = app.now();
    const includeRemoved = request.query.include_removed ?? false;
    const cursor = request.query.cursor === undefined ? null : decodeCursor(request.query.cursor, planet.id, includeRemoved, now);
    if (request.query.cursor !== undefined && cursor === null) return problem(reply, 400, 'invalid_cursor', 'The cursor is invalid or expired. Restart pagination.');
    const watermark = cursor?.watermark ?? (await db.selectFrom('exoplanet_revision').select('id')
      .where('exoplanet_id', '=', planet.id).orderBy('id', 'desc').executeTakeFirst())?.id;
    const sources = [await sourceMeta(db, 'exoplanet-archive', now)];
    if (watermark === undefined) return { data: [], meta: { sources, next_cursor: null } };
    let select = db.selectFrom('exoplanet_revision as revision').select(['revision.id', 'revision.parameters', 'revision.recorded_at'])
      // Preserve Postgres microseconds in cursor anchors even though JSON dates use milliseconds.
      .select(sql<string>`to_char(revision.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('cursor_timestamp'))
      .select((eb) => eb.selectFrom('exoplanet_revision as previous').select('previous.parameters')
        .whereRef('previous.exoplanet_id', '=', 'revision.exoplanet_id').where('previous.id', '<=', watermark)
        .where((previous) => previous.or([
          previous('previous.recorded_at', '<', previous.ref('revision.recorded_at')),
          previous.and([previous('previous.recorded_at', '=', previous.ref('revision.recorded_at')), previous('previous.id', '<', previous.ref('revision.id'))]),
        ])).orderBy('previous.recorded_at', 'desc').orderBy('previous.id', 'desc').limit(1).as('previous_parameters'))
      .where('revision.exoplanet_id', '=', planet.id).where('revision.id', '<=', watermark);
    if (cursor) select = select.where((eb) => eb.or([
      eb('revision.recorded_at', '<', sql<Date>`${cursor.recorded_at}::timestamptz`),
      eb.and([eb('revision.recorded_at', '=', sql<Date>`${cursor.recorded_at}::timestamptz`), eb('revision.id', '<', cursor.id)]),
    ]));
    const limit = request.query.limit ?? 50;
    const rows = await select.orderBy('revision.recorded_at', 'desc').orderBy('revision.id', 'desc').limit(limit + 1).execute();
    const page = rows.slice(0, limit);
    const data = page.map((row) => ({ id: row.id, parameters: row.parameters,
      recorded_at: row.recorded_at, changed_fields: changedFields(row.parameters as unknown as ExoplanetParameters, (row.previous_parameters ?? null) as ExoplanetParameters | null),
    }));
    const last = page.at(-1);
    return { data, meta: { sources, next_cursor: rows.length > limit && last ? encodeCursor({ version: 1,
      planet_id: planet.id, include_removed: includeRemoved, watermark, id: last.id, recorded_at: last.cursor_timestamp,
      expires_at: cursor?.expires_at ?? now.getTime() + cursorLifetimeMs,
    }) : null } };

  }));
}
