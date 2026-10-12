import { Type } from 'typebox';
import type { Database } from '../db/database.js';
import type { Source } from '../domain/source.js';
import { freshness } from '../domain/freshness.js';

export const sourceMetaSchema = Type.Object({
  name: Type.String(), data_as_of: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  stale: Type.Boolean(), attribution: Type.String(),
});
export const metaSchema = Type.Object({ sources: Type.Array(sourceMetaSchema) });
export const EXOPLANET_ARCHIVE_ATTRIBUTION =
  'This research has made use of the NASA Exoplanet Archive, which is operated by the California Institute of Technology, under contract with the National Aeronautics and Space Administration under the Exoplanet Exploration Program. Christiansen et al. (2025), The NASA Exoplanet Archive and Exoplanet Follow-up Observing Program: Data, Tools, and Usage. https://arxiv.org/abs/2506.03299';
// Required attribution and current citation: https://exoplanetarchive.ipac.caltech.edu/docs/acknowledge.html
export async function sourceMeta(db: Database, source: Source, now: Date) {
  const last = await db.selectFrom('ingestion_run').select('finished_at').where('source', '=', source)
    .where('status', '=', 'succeeded').where('finished_at', 'is not', null).orderBy('finished_at', 'desc').executeTakeFirst();
  return { name: source, ...freshness(last?.finished_at ?? null, now),
    attribution: source === 'exoplanet-archive' ? EXOPLANET_ARCHIVE_ATTRIBUTION : 'NASA/JPL Center for Near Earth Object Studies (CNEOS), Near Earth Object Web Service (NeoWs).',
  };
}
