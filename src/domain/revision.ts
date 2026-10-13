import { EXOPLANET_PARAMETER_FIELDS, type ExoplanetParameters } from './exoplanet.js';

/** Typed fields changed from the preceding historical snapshot; the first snapshot has no baseline. */
export function changedFields(current: ExoplanetParameters, previous: ExoplanetParameters | null): Array<keyof ExoplanetParameters> {
  if (previous === null) return [];
  return EXOPLANET_PARAMETER_FIELDS.filter((field) => current[field] !== previous[field]);
}
