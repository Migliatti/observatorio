// NeoWs fonte: one rolling feed request; dates and instants are derived from its millisecond epoch.
import { getText, type HttpOptions } from './http.js';

export interface NeoWsAsteroid {
  jpl_id: string;
  name: string;
  absolute_magnitude_h: number | null;
  estimated_diameter_min_km: number | null;
  estimated_diameter_max_km: number | null;
  is_potentially_hazardous: boolean;
  raw: Record<string, unknown>;
}

export interface NeoWsApproach {
  jpl_id: string;
  date: string;
  approach_at: Date;
  miss_distance_km: number | null;
  relative_velocity_kms: number | null;
  orbiting_body: string | null;
  raw: Record<string, unknown>;
}

export interface NeoWsFeed {
  asteroids: NeoWsAsteroid[];
  approaches: NeoWsApproach[];
}

export class NeoWsResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NeoWsResponseError';
  }
}

export function neoWsFeedUrl(apiKey: string, now: Date): string {
  if (!apiKey.trim()) throw new Error('NASA_API_KEY is missing. See .env.example.');
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() + 6);
  return 'https://api.nasa.gov/neo/rest/v1/feed?' + new URLSearchParams({
    start_date: now.toISOString().slice(0, 10),
    end_date: end.toISOString().slice(0, 10),
    api_key: apiKey,
  }).toString();
}

export async function fetchNeoWs(apiKey: string, now: Date, http: HttpOptions = {}): Promise<NeoWsFeed> {
  return parseNeoWs(await getText(neoWsFeedUrl(apiKey, now), http));
}

/** Pure parser. A valid empty feed is allowed; malformed data fails the entire coleta. */
export function parseNeoWs(body: string): NeoWsFeed {
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch { throw new NeoWsResponseError('NeoWs returned invalid JSON'); }
  const feed = record(record(parsed).near_earth_objects);
  const asteroids = new Map<string, NeoWsAsteroid>();
  const approaches = new Map<string, NeoWsApproach>();
  for (const entries of Object.values(feed)) {
    if (!Array.isArray(entries)) throw new NeoWsResponseError('NeoWs feed date must contain a list');
    for (const entry of entries) {
      const row = record(entry);
      const jplId = text(row.neo_reference_id);
      const name = text(row.name);
      if (!jplId || !name || !/^\d+$/.test(jplId)) throw new NeoWsResponseError('Asteroide is missing its JPL id or name');
      const diameter = row.estimated_diameter == null ? {} : record(record(row.estimated_diameter).kilometers);
      if (typeof row.is_potentially_hazardous_asteroid !== 'boolean') throw new NeoWsResponseError('Invalid hazardous flag');
      asteroids.set(jplId, {
        jpl_id: jplId, name,
        absolute_magnitude_h: numeric(row.absolute_magnitude_h),
        estimated_diameter_min_km: numeric(diameter.estimated_diameter_min),
        estimated_diameter_max_km: numeric(diameter.estimated_diameter_max),
        is_potentially_hazardous: row.is_potentially_hazardous_asteroid,
        raw: row,
      });
      if (!Array.isArray(row.close_approach_data)) throw new NeoWsResponseError('Missing aproximações');
      for (const item of row.close_approach_data) {
        const approach = record(item);
        const epoch = numeric(approach.epoch_date_close_approach);
        if (epoch === null || !Number.isSafeInteger(epoch)) throw new NeoWsResponseError('Invalid aproximação epoch');
        const instant = new Date(epoch);
        if (!Number.isFinite(instant.getTime())) throw new NeoWsResponseError('Invalid aproximação date');
        const date = instant.toISOString().slice(0, 10);
        approaches.set(`${jplId}:${date}`, {
          jpl_id: jplId, date, approach_at: instant,
          miss_distance_km: numeric(record(approach.miss_distance).kilometers),
          relative_velocity_kms: numeric(record(approach.relative_velocity).kilometers_per_second),
          orbiting_body: text(approach.orbiting_body), raw: approach,
        });
      }
    }
  }
  return { asteroids: [...asteroids.values()], approaches: [...approaches.values()] };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new NeoWsResponseError('Expected a NeoWs object');
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new NeoWsResponseError('Expected NeoWs text');
  return value.trim() || null;
}

function numeric(value: unknown): number | null {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))) {
    throw new NeoWsResponseError('Expected a NeoWs numeric value');
  }
  const result = Number(value);
  if (!Number.isFinite(result)) throw new NeoWsResponseError('Expected a finite NeoWs numeric value');
  return result;
}
