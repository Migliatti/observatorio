import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { Type, type Static } from 'typebox';
import { problem, problemResponseSchema } from '../problem.js';
import { metaSchema, sourceMeta } from '../source-meta.js';

const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const nullableString = Type.Union([Type.String(), Type.Null()]);
const dateSchema = Type.String({ format: 'date' });
export const closeApproachSchema = Type.Object({
  date: dateSchema, miss_distance_km: nullableNumber, relative_velocity_kms: nullableNumber, orbiting_body: nullableString,
  asteroid: Type.Object({ id: Type.String(), name: Type.String(), absolute_magnitude_h: nullableNumber,
    estimated_diameter_min_km: nullableNumber, estimated_diameter_max_km: nullableNumber, is_potentially_hazardous: Type.Boolean() }),
});
const querySchema = Type.Object({
  from: Type.Optional(dateSchema), to: Type.Optional(dateSchema), hazardous: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), cursor: Type.Optional(Type.String({ maxLength: 4096 })),
}, { additionalProperties: false });
type Query = Static<typeof querySchema>;
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000-') && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
interface Cursor { version: 1; binding: string; date: string; id: string }
function decodeCursor(encoded: string, binding: string): Cursor | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return null;
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (Object.keys(value).toSorted().join(',') !== 'binding,date,id,version' || value.version !== 1 || value.binding !== binding ||
      typeof value.date !== 'string' || !validDate(value.date) || typeof value.id !== 'string' || !/^[1-9]\d{0,18}$/.test(value.id) || BigInt(value.id) > 9223372036854775807n) return null;
    return value as unknown as Cursor;
  } catch { return null; }
}
export async function closeApproachRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Query }>('/v1/close-approaches', {
    schema: { tags: ['Close approaches'], summary: 'List asteroid close approaches', querystring: querySchema, response: {
      200: Type.Object({ data: Type.Array(closeApproachSchema), meta: Type.Object({ ...metaSchema.properties, coverage: Type.Object({ from: Type.Union([dateSchema, Type.Null()]), to: Type.Union([dateSchema, Type.Null()]) }), next_cursor: nullableString }) }), 400: problemResponseSchema,
    } },
  }, async (request, reply) => {
    const now = app.now();
    const today = now.toISOString().slice(0, 10);
    const from = request.query.from ?? today;
    const to = request.query.to ?? new Date(Date.parse(`${today}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10);
    if (!validDate(from) || !validDate(to) || from > to || (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1 > 366) return problem(reply, 400, 'invalid_input', 'The window must contain valid UTC dates in ascending order and at most 366 days.');
    const binding = createHash('sha256').update(JSON.stringify({ from, to, hazardous: request.query.hazardous ?? false })).digest('hex');
    const cursor = request.query.cursor === undefined ? null : decodeCursor(request.query.cursor, binding);
    if (request.query.cursor !== undefined && (!cursor || cursor.date < from || cursor.date > to)) return problem(reply, 400, 'invalid_cursor', 'The cursor is invalid or belongs to a different query.');
    return app.db.transaction().setIsolationLevel('repeatable read').execute(async (db) => {
      let select = db.selectFrom('close_approach as c').innerJoin('asteroid as a', 'a.id', 'c.asteroid_id')
        .select(['c.id', sql<string>`to_char(c.date, 'YYYY-MM-DD')`.as('date'), 'c.miss_distance_km', 'c.relative_velocity_kms', 'c.orbiting_body',
          'a.jpl_id', 'a.name', 'a.absolute_magnitude_h', 'a.estimated_diameter_min_km', 'a.estimated_diameter_max_km', 'a.is_potentially_hazardous'])
        .where('c.date', '>=', sql<Date>`${from}::date`).where('c.date', '<=', sql<Date>`${to}::date`);
      if (request.query.hazardous) select = select.where('a.is_potentially_hazardous', '=', true);
      if (cursor) select = select.where((eb) => eb.or([eb('c.date', '>', sql<Date>`${cursor.date}::date`), eb.and([eb('c.date', '=', sql<Date>`${cursor.date}::date`), eb('c.id', '>', cursor.id)])]));
      const limit = request.query.limit ?? 50;
      const rows = await select.orderBy('c.date').orderBy('c.id').limit(limit + 1).execute();
      const data = rows.slice(0, limit);
      const last = data.at(-1);
      const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({ version: 1, binding, date: last.date, id: last.id } satisfies Cursor)).toString('base64url') : null;
      return { data: data.map(({ id: _id, jpl_id, name, absolute_magnitude_h, estimated_diameter_min_km, estimated_diameter_max_km, is_potentially_hazardous, ...approach }) => ({
        ...approach, asteroid: { id: jpl_id, name, absolute_magnitude_h, estimated_diameter_min_km, estimated_diameter_max_km, is_potentially_hazardous },
      })), meta: { sources: [await sourceMeta(db, 'neows', now)], next_cursor: nextCursor, coverage: (await sql<{ from: string | null; to: string | null }>`
        select to_char(min(available_from), 'YYYY-MM-DD') as "from", to_char(max(available_to), 'YYYY-MM-DD') as "to"
        from (
          select coverage_from as available_from, coverage_to as available_to from ingestion_run
          where source = 'neows' and status = 'succeeded' and coverage_from is not null
          union all select date, date from close_approach
        ) available
      `.execute(db)).rows[0]! } };
    });
  });
}
