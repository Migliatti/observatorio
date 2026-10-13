import { describe, expect, it } from 'vitest';
import { changedFields } from './revision.js';
import type { ExoplanetParameters } from './exoplanet.js';

const parameters: ExoplanetParameters = {
  name: 'Example b', host_name: 'Example', discovery_method: 'Transit', discovery_year: 2020,
  discovery_facility: null, orbital_period_days: 2.5, semi_major_axis_au: null, eccentricity: null,
  radius_earth_radii: 1, mass_earth_masses: 4, equilibrium_temperature_k: null,
  insolation_earth_flux: null, distance_pc: null, ra_deg: null, dec_deg: null,
  star_effective_temperature_k: null, star_radius_solar_radii: null, star_mass_solar_masses: null,
  system_star_count: 1, system_planet_count: 1,
};

describe('historical revision differences', () => {
  it('reports only typed changes, including known-to-null and null-to-known values, in field order', () => {
    expect(changedFields({ ...parameters, mass_earth_masses: null, discovery_year: 2026, insolation_earth_flux: 2 }, parameters))
      .toEqual(['discovery_year', 'mass_earth_masses', 'insolation_earth_flux']);
    expect(changedFields(parameters, null)).toEqual([]);
    const differentRaw = { ...parameters, raw: { another: true } };
    expect(changedFields(parameters, differentRaw)).toEqual([]);
  });
});
