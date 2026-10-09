// Exoplanet Archive fonte: the composite parameters table (pscomppars), one row per exoplaneta.
import { getText, snippet, type HttpOptions } from './http.js';

/** Archive column → our column. Units follow the Archive's; they are named in our column. */
const COLUMNS = {
  pl_name: 'name',
  hostname: 'host_name',
  discoverymethod: 'discovery_method',
  disc_year: 'discovery_year',
  disc_facility: 'discovery_facility',
  pl_orbper: 'orbital_period_days',
  pl_orbsmax: 'semi_major_axis_au',
  pl_orbeccen: 'eccentricity',
  pl_rade: 'radius_earth_radii',
  pl_bmasse: 'mass_earth_masses',
  pl_eqt: 'equilibrium_temperature_k',
  pl_insol: 'insolation_earth_flux',
  sy_dist: 'distance_pc',
  ra: 'ra_deg',
  dec: 'dec_deg',
  st_teff: 'star_effective_temperature_k',
  st_rad: 'star_radius_solar_radii',
  st_mass: 'star_mass_solar_masses',
  sy_snum: 'system_star_count',
  sy_pnum: 'system_planet_count',
} as const;

const ARCHIVE_COLUMNS = Object.keys(COLUMNS);

/** TAP synchronous query for the whole composite parameters table, as JSON. */
export const EXOPLANET_ARCHIVE_URL =
  'https://exoplanetarchive.ipac.caltech.edu/TAP/sync?' +
  new URLSearchParams({ query: `select ${ARCHIVE_COLUMNS.join(',')} from pscomppars`, format: 'json' }).toString();

/** One exoplaneta as read from the Archive: typed fields plus the original row. */
export interface ArchiveExoplanet {
  name: string;
  host_name: string | null;
  discovery_method: string | null;
  discovery_year: number | null;
  discovery_facility: string | null;
  orbital_period_days: number | null;
  semi_major_axis_au: number | null;
  eccentricity: number | null;
  radius_earth_radii: number | null;
  mass_earth_masses: number | null;
  equilibrium_temperature_k: number | null;
  insolation_earth_flux: number | null;
  distance_pc: number | null;
  ra_deg: number | null;
  dec_deg: number | null;
  star_effective_temperature_k: number | null;
  star_radius_solar_radii: number | null;
  star_mass_solar_masses: number | null;
  system_star_count: number | null;
  system_planet_count: number | null;
  /** The Archive row exactly as received. */
  raw: Record<string, unknown>;
}

/** The typed (non-raw) fields of an exoplaneta, used to detect changed values. */
export const EXOPLANET_FIELDS = Object.values(COLUMNS);

/** The Archive answered, but not with exoplanet data (including errors sent as HTTP 200). */
export class ArchiveResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveResponseError';
  }
}

/** Fetches and parses the composite parameters table. */
export async function fetchExoplanetArchive(options: HttpOptions = {}): Promise<ArchiveExoplanet[]> {
  return parseExoplanetArchive(await getText(EXOPLANET_ARCHIVE_URL, options));
}

/**
 * Parses the Archive's JSON response. Pure. Throws {@link ArchiveResponseError} when the body is not
 * a non-empty JSON array of rows with the expected types: the Archive reports some query errors as
 * HTTP 200 with a text or VOTable body, and those must never be stored as data.
 */
export function parseExoplanetArchive(body: string): ArchiveExoplanet[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ArchiveResponseError(`Exoplanet Archive returned an error instead of JSON: ${describeErrorBody(body)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new ArchiveResponseError(`Exoplanet Archive returned JSON that is not a list of rows: ${snippet(body)}`);
  }
  if (parsed.length === 0) {
    // An empty table would mark every exoplaneta as removed; treat it as a broken response.
    throw new ArchiveResponseError('Exoplanet Archive returned no rows');
  }

  const names = new Set<string>();
  return parsed.map((row: unknown, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new ArchiveResponseError(`Row ${index} is not an object`);
    }
    const record = row as Record<string, unknown>;
    const name = text(record, 'pl_name', index);
    if (name === null) throw new ArchiveResponseError(`Row ${index} has no pl_name`);
    if (names.has(name)) throw new ArchiveResponseError(`Duplicate pl_name "${name}"`);
    names.add(name);
    const where = `"${name}"`;
    return {
      name,
      host_name: text(record, 'hostname', where),
      discovery_method: text(record, 'discoverymethod', where),
      discovery_year: integer(record, 'disc_year', where),
      discovery_facility: text(record, 'disc_facility', where),
      orbital_period_days: number(record, 'pl_orbper', where),
      semi_major_axis_au: number(record, 'pl_orbsmax', where),
      eccentricity: number(record, 'pl_orbeccen', where),
      radius_earth_radii: number(record, 'pl_rade', where),
      mass_earth_masses: number(record, 'pl_bmasse', where),
      equilibrium_temperature_k: number(record, 'pl_eqt', where),
      insolation_earth_flux: number(record, 'pl_insol', where),
      distance_pc: number(record, 'sy_dist', where),
      ra_deg: number(record, 'ra', where),
      dec_deg: number(record, 'dec', where),
      star_effective_temperature_k: number(record, 'st_teff', where),
      star_radius_solar_radii: number(record, 'st_rad', where),
      star_mass_solar_masses: number(record, 'st_mass', where),
      system_star_count: integer(record, 'sy_snum', where),
      system_planet_count: integer(record, 'sy_pnum', where),
      raw: record,
    };
  });
}

function text(row: Record<string, unknown>, key: string, where: string | number): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw invalid(key, value, where);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function number(row: Record<string, unknown>, key: string, where: string | number): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(key, value, where);
  return value;
}

function integer(row: Record<string, unknown>, key: string, where: string | number): number | null {
  const value = number(row, key, where);
  if (value !== null && !Number.isInteger(value)) throw invalid(key, value, where);
  return value;
}

function invalid(key: string, value: unknown, where: string | number): ArchiveResponseError {
  const row = typeof where === 'number' ? `row ${where}` : where;
  return new ArchiveResponseError(`Unexpected value for ${key} in ${row}: ${JSON.stringify(value)}`);
}

/** Pulls the message out of a VOTable error (<INFO name="QUERY_STATUS" value="ERROR">...</INFO>) or plain text. */
function describeErrorBody(body: string): string {
  const info = /<INFO[^>]*value="ERROR"[^>]*>([\s\S]*?)<\/INFO>/i.exec(body)?.[1];
  return snippet((info ?? body).replace(/<[^>]+>/g, ' ')) || '(empty body)';
}
