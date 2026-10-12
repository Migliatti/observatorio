import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchNeoWs, parseNeoWs } from './neows.js';

const body = readFileSync(new URL('./fixtures/neows/feed.json', import.meta.url), 'utf8');

describe('NeoWs fonte', () => {
  it('parses the real numeric strings and millisecond epochs into UTC aproximações', () => {
    const feed = parseNeoWs(body);
    const asteroid = feed.asteroids.find((row) => row.jpl_id === '2440012')!;
    expect(asteroid).toMatchObject({ name: '440012 (2002 LE27)', absolute_magnitude_h: 19.61 });
    const approach = feed.approaches.find((row) => row.jpl_id === '2440012')!;
    expect(approach).toMatchObject({
      date: '2015-09-07', approach_at: new Date('2015-09-07T07:32:00Z'),
      relative_velocity_kms: 1.1630843052, miss_distance_km: 74525035.840942964,
    });
    expect(approach.raw.relative_velocity).toMatchObject({ kilometers_per_second: '1.1630843052' });
  });

  it('makes one feed request for the UTC day through +6 days, crossing the month', async () => {
    const urls: string[] = [];
    await fetchNeoWs('fixture-key', new Date('2026-10-31T23:30:00-03:00'), {
      fetch: async (url) => { urls.push(String(url)); return new Response(body); },
    });
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect(url.searchParams.get('start_date')).toBe('2026-11-01');
    expect(url.searchParams.get('end_date')).toBe('2026-11-07');
    expect(url.searchParams.get('api_key')).toBe('fixture-key');
  });

  it('takes the last duplicate asteroide and aproximação and keeps unknown numeric values null', () => {
    const source = JSON.parse(body);
    const row = source.near_earth_objects['2015-09-07'][0];
    const duplicate = structuredClone(row);
    duplicate.name = 'Updated name';
    duplicate.absolute_magnitude_h = null;
    duplicate.close_approach_data[0].miss_distance.kilometers = '';
    source.near_earth_objects['2015-09-07'].push(duplicate);
    const feed = parseNeoWs(JSON.stringify(source));
    expect(feed.asteroids.filter((item) => item.jpl_id === row.neo_reference_id)).toEqual([
      expect.objectContaining({ name: 'Updated name', absolute_magnitude_h: null }),
    ]);
    expect(feed.approaches.filter((item) => item.jpl_id === row.neo_reference_id)).toEqual([
      expect.objectContaining({ miss_distance_km: null }),
    ]);
  });

  it('rejects malformed feed or numeric data instead of storing a partial response', () => {
    expect(() => parseNeoWs('{"error":"bad key"}')).toThrow('Expected a NeoWs object');
    const source = JSON.parse(body);
    source.near_earth_objects['2015-09-07'][0].close_approach_data[0].miss_distance.kilometers = 'unknown';
    expect(() => parseNeoWs(JSON.stringify(source))).toThrow('numeric value');
    expect(parseNeoWs('{"near_earth_objects":{}}')).toEqual({ asteroids: [], approaches: [] });
  });
});
