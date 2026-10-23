// Public archive contract. New columns/tables require an explicit security review here.
const planet = `id name host_name discovery_method discovery_year discovery_facility orbital_period_days semi_major_axis_au eccentricity radius_earth_radii mass_earth_masses equilibrium_temperature_k insolation_earth_flux distance_pc ra_deg dec_deg star_effective_temperature_k star_radius_solar_radii star_mass_solar_masses system_star_count system_planet_count first_seen_at last_seen_at removed_at`;
export const tables = [
  ['ingestion_run', 'id source started_at finished_at status seen_count created_count revised_count coverage_from coverage_to'],
  ['exoplanet', `${planet} content_hash`],
  ['exoplanet_revision', 'id exoplanet_id parameters content_hash recorded_at'],
  ['exoplanet_catalogue', 'id ingestion_run_id data_as_of created_at expires_at'],
  ['exoplanet_catalogue_item', `${planet} catalogue_id`],
  ['asteroid', 'id jpl_id name absolute_magnitude_h estimated_diameter_min_km estimated_diameter_max_km is_potentially_hazardous first_seen_at last_seen_at'],
  ['close_approach', 'id asteroid_id date approach_at miss_distance_km relative_velocity_kms orbiting_body first_seen_at last_seen_at'],
].map(([name, columns]) => ({ name: name!, columns: columns!.split(' ') }));

// Historical revision parameters are typed scientific fields, never raw upstream JSON.
export const revisionFields = planet.split(' ').filter((key) => ![
  'id', 'first_seen_at', 'last_seen_at', 'removed_at',
].includes(key));
