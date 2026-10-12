import { sql, type Transaction } from 'kysely';
import type { DB } from '../db/generated/database.js';
import { fetchNeoWs, neoWsFeedUrl, type NeoWsFeed } from '../sources/neows.js';
import type { HttpOptions } from '../sources/http.js';
import type { CollectionCounts, Collector } from './run.js';

export function neoWsCollector(apiKey: string, now: () => Date = () => new Date(), http: HttpOptions = {}): Collector<NeoWsFeed> {
  let coverage: { from: string; to: string } | null = null;
  return {
    fetch: () => {
      // Capture the exact requested window before I/O, even if midnight passes before publication.
      const requestedAt = now();
      const params = new URL(neoWsFeedUrl(apiKey, requestedAt)).searchParams;
      coverage = { from: params.get('start_date')!, to: params.get('end_date')! };
      return fetchNeoWs(apiKey, requestedAt, http);
    },
    store: storeNeoWs,
    publish: async (trx, runId) => {
      if (!coverage) throw new Error('NeoWs coverage is missing.');
      await trx.updateTable('ingestion_run').set({
        coverage_from: sql<Date>`${coverage.from}::date`, coverage_to: sql<Date>`${coverage.to}::date`,
      }).where('id', '=', runId).execute();
    },
  };
}

/** Counts refer to aproximações, the records collected by the rolling feed. */
export async function storeNeoWs(trx: Transaction<DB>, feed: NeoWsFeed, now: Date): Promise<CollectionCounts> {
  const ids = new Map<string, string>();
  for (const { raw, ...asteroid } of feed.asteroids) {
    const stored = await trx.insertInto('asteroid').values({
      ...asteroid, raw: JSON.stringify(raw), first_seen_at: now, last_seen_at: now,
    }).onConflict((oc) => oc.column('jpl_id').doUpdateSet({
      ...asteroid, raw: JSON.stringify(raw), last_seen_at: now,
    })).returning('id').executeTakeFirstOrThrow();
    ids.set(asteroid.jpl_id, stored.id);
  }

  let created = 0;
  let revised = 0;
  const today = now.toISOString().slice(0, 10);
  for (const { jpl_id: jplId, raw, ...approach } of feed.approaches) {
    const asteroidId = ids.get(jplId);
    if (!asteroidId) throw new Error(`Missing asteroide ${jplId} for aproximação`);
    const previous = await trx.selectFrom('close_approach').selectAll()
      .where('asteroid_id', '=', asteroidId).where('date', '=', sql<Date>`${approach.date}::date`).executeTakeFirst();
    // All fields, including raw and last_seen_at, stay frozen once the UTC day has passed.
    if (previous && approach.date < today) continue;
    if (!previous) created++;
    else if (
      previous.approach_at.getTime() !== approach.approach_at.getTime() ||
      previous.miss_distance_km !== approach.miss_distance_km ||
      previous.relative_velocity_kms !== approach.relative_velocity_kms ||
      previous.orbiting_body !== approach.orbiting_body
    ) revised++;
    await trx.insertInto('close_approach').values({
      asteroid_id: asteroidId, ...approach, raw: JSON.stringify(raw), first_seen_at: now, last_seen_at: now,
    }).onConflict((oc) => oc.columns(['asteroid_id', 'date']).doUpdateSet({
      ...approach, raw: JSON.stringify(raw), last_seen_at: now,
    }).where('close_approach.date', '>=', sql<Date>`${today}::date`)).execute();
  }
  return { seen: feed.approaches.length, created, revised };
}
