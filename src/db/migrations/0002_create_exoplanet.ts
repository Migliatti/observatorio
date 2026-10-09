import { sql, type Kysely } from 'kysely';

// Exoplaneta: planeta confirmado fora do Sistema Solar, identificado pelo nome do Exoplanet Archive.
// One unit per quantity, named in the column; NULL when the fonte has no value.
// A planeta removido keeps its row with removed_at set; it is never deleted.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table exoplanet (
      id bigint generated always as identity primary key,
      name text not null unique,
      host_name text,
      discovery_method text,
      discovery_year integer,
      discovery_facility text,
      orbital_period_days double precision,
      semi_major_axis_au double precision,
      eccentricity double precision,
      radius_earth_radii double precision,
      mass_earth_masses double precision,
      equilibrium_temperature_k double precision,
      insolation_earth_flux double precision,
      distance_pc double precision,
      ra_deg double precision,
      dec_deg double precision,
      star_effective_temperature_k double precision,
      star_radius_solar_radii double precision,
      star_mass_solar_masses double precision,
      system_star_count integer,
      system_planet_count integer,
      raw jsonb not null,
      first_seen_at timestamptz not null,
      last_seen_at timestamptz not null,
      removed_at timestamptz
    )
  `.execute(db);
}
