import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { Type, type Static } from 'typebox';
import { problem, problemSchema } from '../problem.js';
import { metaSchema, sourceMeta } from '../source-meta.js';

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
interface Cursor { version: 1; binding: string; id: string; value: string | number | null; max_id: string }

function binding(query: ListQuery, dataAsOf: string | null): string {
  const { cursor: _cursor, limit: _limit, ...filters } = query;
  return createHash('sha256').update(JSON.stringify(Object.entries({ ...filters, data_as_of: dataAsOf, sort: query.sort ?? 'name', order: query.order ?? 'asc', include_removed: query.include_removed ?? false }).toSorted(([a], [b]) => a.localeCompare(b)))).digest('hex');
}
function encodeCursor(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
const validId = (id: unknown): id is string => typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n;
function decodeCursor(encoded: string, expectedBinding: string, sort: Sort): Cursor | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) return null;
    const value: unknown = JSON.parse(decoded.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).toSorted().join(',') !== 'binding,id,max_id,value,version' || item.version !== 1 || item.binding !== expectedBinding || !validId(item.id) || !validId(item.max_id) || BigInt(item.id) > BigInt(item.max_id)) return null;
    if (sort === 'name' ? typeof item.value !== 'string' || item.value.length === 0 || item.value.length > 200 : item.value !== null && (typeof item.value !== 'number' || !Number.isFinite(item.value) || item.value < 0 || (sort === 'discovery_year' && !Number.isInteger(item.value)))) return null;
    return item as unknown as Cursor;
  } catch { return null; }
}

export async function exoplanetRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListQuery }>('/v1/exoplanets', {
    schema: { tags: ['Exoplanets'], summary: 'List confirmed exoplanets', querystring: listQuery,
      response: { 200: Type.Object({ data: Type.Array(exoplanetSchema), meta: Type.Object({ ...metaSchema.properties, next_cursor: nullableString }) }), 400: problemSchema },
    },
  }, async (request, reply) => {
    return app.db.transaction().setIsolationLevel('repeatable read').execute(async (db) => {
      const query = request.query;
      for (const [, min, max] of ranges) {
        if (query[min] !== undefined && query[max] !== undefined && query[min] > query[max]) return problem(reply, 400, 'invalid_input', `${min} must not exceed ${max}.`);
      }
      const sort = query.sort ?? 'name';
      const order = query.order ?? 'asc';
      const limit = query.limit ?? 50;
      const source = await sourceMeta(db, 'exoplanet-archive', app.now());
      const queryBinding = binding(query, source.data_as_of);
      const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor, queryBinding, sort);
      if (query.cursor !== undefined && cursor === null) return problem(reply, 400, 'invalid_cursor', 'The cursor is invalid for this query or the fonte has completed a new coleta. Restart pagination.');
      // An insertion during navigation cannot extend the catalogue beyond this first-page boundary.
      const maxId = cursor?.max_id ?? (await db.selectFrom('exoplanet').select(({ fn }) => fn.max('id').as('max_id')).executeTakeFirst())?.max_id;
      let select = db.selectFrom('exoplanet').select(fields);
      if (!query.include_removed) select = select.where('removed_at', 'is', null);
      if (maxId) select = select.where('id', '<=', maxId);
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
        next_cursor: rows.length > limit && last && maxId ? encodeCursor({ version: 1, binding: queryBinding, id: last.id, value: last[sort], max_id: maxId }) : null,
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
