import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const column of ['name', 'discovery_year', 'radius_earth_radii', 'mass_earth_masses']) {
    await sql`create index ${sql.id(`exoplanet_${column}_id_idx`)} on exoplanet (${sql.id(column)}, id)`.execute(db);
  }
}
