import { describe, expect, it } from 'vitest';
import { exoplanetContentHash, type ExoplanetParameters } from './exoplanet.js';

const parameters: ExoplanetParameters = {
  name: 'Example b', host_name: 'Example', discovery_method: 'Transit', discovery_year: 2026,
  discovery_facility: null, orbital_period_days: 2.5, semi_major_axis_au: null, eccentricity: null,
  radius_earth_radii: 1, mass_earth_masses: null, equilibrium_temperature_k: null,
  insolation_earth_flux: null, distance_pc: null, ra_deg: null, dec_deg: null,
  star_effective_temperature_k: null, star_radius_solar_radii: null, star_mass_solar_masses: null,
  system_star_count: 1, system_planet_count: 1,
};

describe('exoplaneta content hash', () => {
  it('is stable independently of object key order and ignores raw and coleta metadata', () => {
    const reordered = Object.fromEntries(Object.entries(parameters).toReversed()) as unknown as ExoplanetParameters;
    const hash = exoplanetContentHash(parameters);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(exoplanetContentHash(reordered)).toBe(hash);
    expect(exoplanetContentHash({ ...parameters, raw: { value: 'changed' }, last_seen_at: new Date() } as ExoplanetParameters)).toBe(hash);
  });

  it('changes when a typed parameter changes, including a missing value becoming known', () => {
    expect(exoplanetContentHash({ ...parameters, mass_earth_masses: 1 })).not.toBe(exoplanetContentHash(parameters));
    expect(exoplanetContentHash({ ...parameters, orbital_period_days: 3 })).not.toBe(exoplanetContentHash(parameters));
  });
});
