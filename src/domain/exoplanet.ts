import { createHash } from 'node:crypto';

/** Typed parameters supplied by the Exoplanet Archive; collection metadata and raw are excluded. */
export interface ExoplanetParameters {
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
}

export const EXOPLANET_PARAMETER_FIELDS = [
  'name', 'host_name', 'discovery_method', 'discovery_year', 'discovery_facility',
  'orbital_period_days', 'semi_major_axis_au', 'eccentricity', 'radius_earth_radii',
  'mass_earth_masses', 'equilibrium_temperature_k', 'insolation_earth_flux', 'distance_pc',
  'ra_deg', 'dec_deg', 'star_effective_temperature_k', 'star_radius_solar_radii',
  'star_mass_solar_masses', 'system_star_count', 'system_planet_count',
] as const satisfies readonly (keyof ExoplanetParameters)[];

/** Selects the typed parameters in a fixed order, independently of the input object's key order. */
export function exoplanetParameters(exoplanet: ExoplanetParameters): ExoplanetParameters {
  return Object.fromEntries(EXOPLANET_PARAMETER_FIELDS.map((field) => [field, exoplanet[field]])) as unknown as ExoplanetParameters;
}

/** SHA256 of canonical JSON: raw source data and collection timestamps never cause a revision. */
export function exoplanetContentHash(exoplanet: ExoplanetParameters): string {
  return createHash('sha256').update(JSON.stringify(exoplanetParameters(exoplanet))).digest('hex');
}
