import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { CATALOGUE_RETENTION_MS, EXOPLANET_CATALOGUE_LOCK } from '../../db/exoplanet-catalogue.js';
import { freshness } from '../../domain/freshness.js';
import type { FastifyInstance } from 'fastify';
import { Type, type Static } from 'typebox';
import { problem, problemSchema } from '../problem.js';
import { EXOPLANET_ARCHIVE_ATTRIBUTION, metaSchema, sourceMeta } from '../source-meta.js';

const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const nullableString = Type.Union([Type.String(), Type.Null()]);
const timestamp = Type.String({ format: 'date-time' });
const nullableTimestamp = Type.Union([timestamp, Type.Null()]);
export const exoplanetSchema = Type.Object({
  id: Type.String(), name: Type.String(), host_name: nullableString,
  discovery_method: nullableString, discovery_year: nullableNumber, discovery_facility: nullableString,
  orbital_period_days: nullableNumber, semi_major_axis_au: nullableNumber, eccentricity: nullableNumber,
  radius_earth_radii: nullableNumber, mass_earth_masses: nullableNumber,
  equilibrium_temperature_k: nullableNumber, insolation_earth_flux: nullableNumber,
  distance_pc: nullableNumber, ra_deg: nullableNumber, dec_deg: nullableNumber,
  star_effective_temperature_k: nullableNumber, star_radius_solar_radii: nullableNumber, star_mass_solar_masses: nullableNumber,
  system_star_count: nullableNumber, system_planet_count: nullableNumber,
  first_seen_at: timestamp, last_seen_at: timestamp, removed_at: nullableTimestamp,
});
const fields = Object.keys(exoplanetSchema.properties) as (keyof typeof exoplanetSchema.properties)[];
const sortSchema = Type.Union([Type.Literal('name'), Type.Literal('discovery_year'), Type.Literal('radius_earth_radii'), Type.Literal('mass_earth_masses')]);
const boundedNumber = Type.Optional(Type.Number({ minimum: 0 }));
const listQuery = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  host_name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  discovery_method: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  discovery_year_min: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647 })), discovery_year_max: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647 })),
  radius_earth_radii_min: boundedNumber, radius_earth_radii_max: boundedNumber,
  mass_earth_masses_min: boundedNumber, mass_earth_masses_max: boundedNumber,
  include_removed: Type.Optional(Type.Boolean()), sort: Type.Optional(sortSchema),
  order: Type.Optional(Type.Union([Type.Literal('asc'), Type.Literal('desc')])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  cursor: Type.Optional(Type.String({ maxLength: 4096 })),
}, { additionalProperties: false });
type ListQuery = Static<typeof listQuery>;
type Sort = Static<typeof sortSchema>;
const ranges = [
  ['discovery_year', 'discovery_year_min', 'discovery_year_max'],
  ['radius_earth_radii', 'radius_earth_radii_min', 'radius_earth_radii_max'],
  ['mass_earth_masses', 'mass_earth_masses_min', 'mass_earth_masses_max'],
] as const;
interface Cursor { version: 2; binding: string; catalogue_id: string; id: string; value: string | number | null; expires_at: number }

function binding(query: ListQuery): string {
  const { cursor: _cursor, limit: _limit, ...filters } = query;
  return createHash('sha256').update(JSON.stringify(Object.entries({ ...filters, sort: query.sort ?? 'name', order: query.order ?? 'asc', include_removed: query.include_removed ?? false }).toSorted(([a], [b]) => a.localeCompare(b)))).digest('hex');
}
function encodeCursor(cursor: Cursor, key: string): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}
function validCursorSignature(encoded: string, key: string): boolean {
  const [payload, signature] = encoded.split('.');
  if (!payload || !signature) return false;
  const expected = createHmac('sha256', key).update(payload).digest();
  const received = Buffer.from(signature, 'base64url');
  return received.length === expected.length && received.toString('base64url') === signature && timingSafeEqual(received, expected);
}
const validId = (id: unknown): id is string => typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n;
function decodeCursor(encoded: string, expectedBinding: string, sort: Sort, now: Date): Cursor | null {
  try {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(encoded)) return null;
    const payload = encoded.split('.')[0]!;
    const decoded = Buffer.from(payload, 'base64url');
    if (decoded.toString('base64url') !== payload) return null;
    const value: unknown = JSON.parse(decoded.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).toSorted().join(',') !== 'binding,catalogue_id,expires_at,id,value,version' || item.version !== 2 || item.binding !== expectedBinding || !validId(item.id) || !validId(item.catalogue_id)) return null;
    if (typeof item.expires_at !== 'number' || !Number.isSafeInteger(item.expires_at) || item.expires_at <= now.getTime() || item.expires_at > now.getTime() + CATALOGUE_RETENTION_MS) return null;
    if (sort === 'name' ? typeof item.value !== 'string' || item.value.length === 0 || item.value.length > 200 : item.value !== null && (typeof item.value !== 'number' || !Number.isFinite(item.value) || item.value < 0 || (sort === 'discovery_year' && !Number.isInteger(item.value)))) return null;
    return item as unknown as Cursor;
  } catch { return null; }
}

export async function exoplanetRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListQuery }>('/v1/exoplanets', {
    schema: { tags: ['Exoplanets'], summary: 'List confirmed exoplanets', querystring: listQuery,
      response: { 200: Type.Object({ data: Type.Array(exoplanetSchema), meta: Type.Object({ ...metaSchema.properties, next_cursor: nullableString, updates_available: Type.Boolean(), snapshot_expires_at: nullableTimestamp }) }), 400: problemSchema },
    },
  }, async (request, reply) => {
    const firstPage = request.query.cursor === undefined;
    return app.db.transaction().setIsolationLevel(firstPage ? 'read committed' : 'repeatable read').execute(async (db) => {
      // READ COMMITTED obtains a fresh catalogue after a publication that held the lock.
      // A shared transaction lock keeps first-page selection and its deadline together.
      if (firstPage) await sql`select pg_advisory_xact_lock_shared(hashtextextended(${EXOPLANET_CATALOGUE_LOCK}, 0))`.execute(db);
      const query = request.query;
      for (const [, min, max] of ranges) {
        if (query[min] !== undefined && query[max] !== undefined && query[min] > query[max]) return problem(reply, 400, 'invalid_input', `${min} must not exceed ${max}.`);
      }
      const sort = query.sort ?? 'name';
      const order = query.order ?? 'asc';
      const limit = query.limit ?? 50;
      const now = app.now();
      const queryBinding = binding(query);
      const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor, queryBinding, sort, now);
      if (query.cursor !== undefined && cursor === null) return problem(reply, 400, 'invalid_cursor', 'The cursor is invalid or expired. Restart pagination.');
      const latest = await db.selectFrom('exoplanet_catalogue').selectAll().orderBy('id', 'desc').executeTakeFirst();
      const catalogue = cursor
        ? await db.selectFrom('exoplanet_catalogue').selectAll().where('id', '=', cursor.catalogue_id).executeTakeFirst()
        : latest;
      if (cursor && (!catalogue || !validCursorSignature(query.cursor!, catalogue.cursor_key) || (catalogue.expires_at && catalogue.expires_at.getTime() <= now.getTime()))) {
        return problem(reply, 400, 'invalid_cursor', 'The catalogue version has expired. Restart pagination.');
      }
      if (!catalogue) return { data: [], meta: {
        sources: [await sourceMeta(db, 'exoplanet-archive', now)], next_cursor: null,
        updates_available: false, snapshot_expires_at: null,
      } };
      const source = { name: 'exoplanet-archive', ...freshness(catalogue.data_as_of, now), attribution: EXOPLANET_ARCHIVE_ATTRIBUTION };
      const expiresAt = cursor?.expires_at ?? now.getTime() + CATALOGUE_RETENTION_MS;
      let select = db.selectFrom('exoplanet_catalogue_item').select(fields).where('catalogue_id', '=', catalogue.id);
      if (!query.include_removed) select = select.where('removed_at', 'is', null);
      if (query.name !== undefined) {
        const literal = query.name.replace(/[\\%_]/g, '\\$&');
        select = select.where('name', 'ilike', `%${literal}%`);
      }
      if (query.host_name !== undefined) select = select.where('host_name', '=', query.host_name);
      if (query.discovery_method !== undefined) select = select.where('discovery_method', '=', query.discovery_method);
      for (const [column, min, max] of ranges) {
        if (query[min] !== undefined) select = select.where(column, '>=', query[min]);
        if (query[max] !== undefined) select = select.where(column, '<=', query[max]);
      }
      if (cursor) {
        const comparator = order === 'asc' ? '>' : '<';
        select = select.where((eb) => cursor.value === null
          ? eb.and([eb(sort, 'is', null), eb('id', comparator, cursor.id)])
          : eb.or([eb(sort, 'is', null), eb(sort, comparator, cursor.value), eb.and([eb(sort, '=', cursor.value), eb('id', comparator, cursor.id)])]));
      }
      const rows = await select.orderBy(sql`${sql.ref(sort)} ${sql.raw(order)} nulls last`).orderBy('id', order).limit(limit + 1).execute();
      const data = rows.slice(0, limit);
      const last = data.at(-1);
      return { data, meta: { sources: [source],
        next_cursor: rows.length > limit && last ? encodeCursor({ version: 2, binding: queryBinding, catalogue_id: catalogue.id, id: last.id, value: last[sort], expires_at: expiresAt }, catalogue.cursor_key) : null,
        updates_available: latest?.id !== catalogue.id, snapshot_expires_at: new Date(expiresAt).toISOString(),
      } };
    });
  });
  const detailQuery = Type.Object({ include_removed: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
  app.get<{ Params: { name: string }; Querystring: Static<typeof detailQuery> }>('/v1/exoplanets/:name', {
    schema: { tags: ['Exoplanets'], summary: 'Get an exoplanet by its URL-encoded Archive name',
      params: Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }) }), querystring: detailQuery,
      response: { 200: Type.Object({ data: exoplanetSchema, meta: metaSchema }), 400: problemSchema, 404: problemSchema },
    },
  }, async (request, reply) => {
    return app.db.transaction().setIsolationLevel('repeatable read').execute(async (db) => {
      let select = db.selectFrom('exoplanet').select(fields).where('name', '=', request.params.name);
      if (!request.query.include_removed) select = select.where('removed_at', 'is', null);
      const data = await select.executeTakeFirst();
      if (!data) return problem(reply, 404, 'not_found', 'The exoplanet was not found.');
      return { data, meta: { sources: [await sourceMeta(db, 'exoplanet-archive', app.now())] } };
    });
  });
}
