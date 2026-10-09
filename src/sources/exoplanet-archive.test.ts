import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveResponseError, EXOPLANET_ARCHIVE_URL, parseExoplanetArchive } from './exoplanet-archive.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/exoplanet-archive/${name}`, import.meta.url), 'utf8');

describe('parseExoplanetArchive', () => {
  it('maps every row of the composite parameters table to typed fields', () => {
    const planets = parseExoplanetArchive(fixture('pscomppars.json'));

    expect(planets.map((planet) => planet.name)).toEqual([
      'HAT-P-8 b',
      'HD 2039 b',
      'K2-43 b',
      '2MASS J04414489+2301513 b',
      'AB Pic b',
    ]);
    const { raw, ...fields } = planets[0]!;
    expect(fields).toEqual({
      name: 'HAT-P-8 b',
      host_name: 'HAT-P-8',
      discovery_method: 'Transit',
      discovery_year: 2008,
      discovery_facility: 'HATNet',
      orbital_period_days: 3.07634,
      semi_major_axis_au: 0.04496,
      eccentricity: 0,
      radius_earth_radii: 15.6926,
      mass_earth_masses: 406.8224,
      equilibrium_temperature_k: 1713,
      insolation_earth_flux: 1519.9645,
      distance_pc: 211.553,
      ra_deg: 343.0414932,
      dec_deg: 35.4471778,
      star_effective_temperature_k: 6200,
      star_radius_solar_radii: 1.57,
      star_mass_solar_masses: 1.27,
      system_star_count: 3,
      system_planet_count: 1,
    });
    expect(raw).toMatchObject({ pl_name: 'HAT-P-8 b', pl_rade: 15.6926, sy_snum: 3 });
  });

  it('keeps absent values as null', () => {
    const planet = parseExoplanetArchive(fixture('pscomppars.json')).find((p) => p.name === 'AB Pic b')!;
    expect(planet.orbital_period_days).toBeNull();
    expect(planet.eccentricity).toBeNull();
    expect(planet.semi_major_axis_au).toBe(260);
  });

  it('treats an error sent with HTTP 200 as a failure', () => {
    expect(() => parseExoplanetArchive(fixture('error-http-200.xml'))).toThrow(ArchiveResponseError);
    expect(() => parseExoplanetArchive(fixture('error-http-200.xml'))).toThrow(/ORA-00904: 'PL_ORBPER': invalid identifier/);
    expect(() => parseExoplanetArchive('ERROR<br>Query timed out')).toThrow(/Query timed out/);
  });

  it('rejects an empty table, which would mark every exoplaneta as removed', () => {
    expect(() => parseExoplanetArchive('[]')).toThrow(/no rows/);
  });

  it('rejects JSON that is not a list of rows', () => {
    expect(() => parseExoplanetArchive('{"error": "x"}')).toThrow(ArchiveResponseError);
    expect(() => parseExoplanetArchive('[42]')).toThrow(/Row 0 is not an object/);
  });

  it('rejects rows without a name and duplicate names', () => {
    expect(() => parseExoplanetArchive('[{"pl_name": null}]')).toThrow(/no pl_name/);
    expect(() => parseExoplanetArchive('[{"pl_name": "a b"}, {"pl_name": "a b"}]')).toThrow(/Duplicate pl_name/);
  });

  it('rejects values of the wrong type instead of storing them', () => {
    expect(() => parseExoplanetArchive('[{"pl_name": "a b", "pl_rade": "1.2"}]')).toThrow(
      /Unexpected value for pl_rade in "a b"/,
    );
    expect(() => parseExoplanetArchive('[{"pl_name": "a b", "disc_year": 2001.5}]')).toThrow(/disc_year/);
  });
});

describe('EXOPLANET_ARCHIVE_URL', () => {
  it('queries the whole composite parameters table as JSON', () => {
    const url = new URL(EXOPLANET_ARCHIVE_URL);
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('query')).toMatch(/^select pl_name,.* from pscomppars$/);
  });
});
