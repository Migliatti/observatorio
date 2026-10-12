/** Frescor is measured from the last successful coleta; both v1 fontes run daily. */
export function freshness(dataAsOf: Date | null, now: Date): { data_as_of: string | null; stale: boolean } {
  return {
    data_as_of: dataAsOf?.toISOString() ?? null,
    stale: dataAsOf === null || now.getTime() - dataAsOf.getTime() > 48 * 60 * 60 * 1000,
  };
}
