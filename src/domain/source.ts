// Pure domain rules: no network, database or global clock.

/** Fontes coletadas no v1. */
export const SOURCES = ['exoplanet-archive', 'neows'] as const;

export type Source = (typeof SOURCES)[number];

export function isSource(value: string): value is Source {
  return (SOURCES as readonly string[]).includes(value);
}
