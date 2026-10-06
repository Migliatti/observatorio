# Research: NASA NeoWs API and NASA Exoplanet Archive (TAP/ADQL)

Resolves Migliatti/observatorio#2 (child of #1). Date checked: **2026-10-06**. Sources: official NASA / NExScI-IPAC docs, plus live probes of the official endpoints (marked **[probed]**). Doc pages were read via a fetch-and-summarise tool, so quotes are as returned.

## Answer gist

- **NeoWs**: free, REST/JSON, needs an api.nasa.gov key (`DEMO_KEY` works for trying). Registered key: 1,000 req/hour. Feed endpoint is capped at a **7-day window**. Data is JPL CNEOS's; refreshed about daily (stats `last_updated` = today).
- **Exoplanet Archive**: free, **no key**, TAP (ADQL 2.0) at `https://exoplanetarchive.ipac.caltech.edu/TAP`. CSV/JSON/VOTable/TSV/IPAC. No documented rate limit or row cap (full `ps` table, ~40k rows, returned in one sync call). Roughly weekly releases.
- Both are US-government data; credit NASA. The archive publishes a requested acknowledgement sentence.

## NeoWs (Near Earth Object Web Service)

Base: `https://api.nasa.gov/neo/rest/v1/` (all calls need `?api_key=KEY`).

| Endpoint | Purpose |
|---|---|
| `GET /feed?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD` | NEOs by close-approach date. Defaults to today if omitted. |
| `GET /neo/{asteroid_id}` | Single NEO (SPK-ID, e.g. 3542519), full `orbital_data` + all `close_approach_data` (282 entries for that id) **[probed]** |
| `GET /neo/browse?page=N&size=M` | Paginated full catalogue; default size 20; 62,576 objects / 3,129 pages **[probed]** |
| `GET /stats` | Counts: `near_earth_object_count`, `close_approach_count`, `last_updated` **[probed]** |

- Auth: key in query string. Missing/invalid key returns JSON `API_KEY_MISSING` / `API_KEY_INVALID` **[probed]**. Signup is free at https://api.nasa.gov.
- Rate limits (https://api.nasa.gov/assets/html/authentication.html): registered key **1,000 requests/hour** (rolling; excess = key blocked until the hour passes; higher limits by contacting NASA); `DEMO_KEY` **30/hour and 50/day per IP**. Limits apply across all api.nasa.gov APIs for that key. Counters are in `X-RateLimit-Limit` / `X-RateLimit-Remaining` headers. **[probed]**: DEMO_KEY returned `X-Ratelimit-Limit: 10` today, lower than the documented 30, so DEMO_KEY is unsuitable for anything real and its limit may change without notice.
- Pagination: feed has none; it returns `links.next/previous` that step the window. Browse uses `page`/`size` and returns a `page` object (`size, number, total_elements, total_pages`).
- Window limit **[probed]**: a 19-day feed request returns 400 "The Feed date limit is only 7 Days". Backfilling history means looping in 7-day chunks.
- Useful fields for an aggregator (feed item) **[probed]**: `id`, `neo_reference_id`, `name`, `designation`, `absolute_magnitude_h`, `is_potentially_hazardous_asteroid`, `is_sentry_object`, `nasa_jpl_url`, `estimated_diameter.{meters,kilometers,miles,feet}.{min,max}`, `close_approach_data[]` (`close_approach_date`, `close_approach_date_full`, `epoch_date_close_approach` in ms, `relative_velocity.{kilometers_per_second,...}`, `miss_distance.{astronomical,lunar,kilometers,miles}`, `orbiting_body`). Velocity and miss-distance values are **strings**; diameters are numbers. Lookup/browse additionally give `orbital_data` (semi_major_axis, eccentricity, inclination, orbit_class, orbital_period, minimum_orbit_intersection, first/last_observation_date, orbit_determination_date, orbit_uncertainty, ...). Stable key: `id` (SPK-ID, string).
- Update frequency: upstream is JPL CNEOS (`/stats` says "All the NEO data is from NASA JPL NEO team"; `last_updated` was 2026-10-06, i.e. today **[probed]**). No documented SLA; treat as daily. Orbit solutions and predicted approaches get revised as new observations arrive, so re-fetch rather than treat rows as immutable.
- Terms/attribution: no NeoWs-specific license text found. NASA media guidelines (https://www.nasa.gov/nasa-brand-center/images-and-media/): content generally not subject to copyright in the US; acknowledge NASA as source; do not imply NASA endorsement; do not attribute AI outputs to NASA.
- Caveat: the swagger UI (https://www.neowsapp.com/swagger-ui/index.html) responded 200 but was not parsed; the endpoint list above comes from live responses and their `links`.

## NASA Exoplanet Archive (TAP)

Docs: https://exoplanetarchive.ipac.caltech.edu/docs/TAP/usingTAP.html

- Endpoints: sync `https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=<ADQL>&format=<fmt>`; TAP root for clients (PyVO/TOPCAT) `.../TAP`; async `.../TAP/async` (responded 303 **[probed]**); `/TAP/capabilities` and `/TAP/availability` (VOSI; "TAP service available" **[probed]**). Language: ADQL 2.0 **[probed capabilities]**.
- Auth: **none**. No key.
- Formats (`format=`): VOTable (default), IPAC table, JSON, TSV, CSV. JSON is an array of row objects **[probed]**.
- Limits: the docs state none for rate, concurrency or rows; they say most tables are small enough that sync queries suffice and recommend TAP clients for large downloads. **[probed]**: unrestricted `select pl_name from ps` returned about 40,194 rows in one sync call. `maxrec=N` and `select top N` both work **[probed]**. Absence of a documented limit is not a guarantee; the help desk (https://exoplanetarchive.ipac.caltech.edu/applications/Helpdesk) is the only channel for it. Be polite: cache, one query per refresh.
- Pagination: none in TAP; use `top`/`maxrec` with `order by` and `where` filters (ADQL 2.0 has no OFFSET), or pull the whole table.
- Legacy API is deprecated: only `missionstars` and `mission_exocat` still use it; all other tables are TAP only (https://exoplanetarchive.ipac.caltech.edu/docs/program_interfaces.html).
- Tables: more than 30; key ones are `ps` (one row per planet per reference; has `default_flag`), `pscomppars` (one row per planet, composite of default values with gaps filled and some values calculated; docs warn that a row's parameters may come from different sources), `toi`, `keplernames`, `k2names`, time-series tables.
- Useful columns (https://exoplanetarchive.ipac.caltech.edu/docs/API_PS_columns.html): `pl_name`, `hostname`, `discoverymethod`, `disc_year`, `disc_facility`, `pl_rade` (Earth radii), `pl_bmasse` (best mass estimate, Earth masses), `pl_orbper` (days), `sy_dist` (parsec), `sy_pnum` (planets in system), `default_flag`, `pl_pubdate`, `disc_pubdate`. **[probed]** Date columns differ per table: `ps` has `rowupdate`, `releasedate`, `pl_pubdate`, `disc_pubdate`; `pscomppars` has only `disc_pubdate` among those (querying `rowupdate`/`releasedate` on it fails with ORA-00904). For incremental sync use `ps` (filter `default_flag=1`, order by `releasedate`/`rowupdate`) or diff `pscomppars` by hash. Stable key: `pl_name`.
- Size now **[probed]**: `select count(*) from pscomppars` = 6,375 confirmed planets (news page: 6,366 on 2026-09-11).
- Errors come back as HTTP 200 with a VOTable `QUERY_STATUS=ERROR` (Oracle `ORA-xxxxx` messages) **[probed]**; check the body, not the status code.
- Update frequency (news archive https://exoplanetarchive.ipac.caltech.edu/docs/exonews_archive.html): entries on 2026-08-06, 08-20, 08-27, 09-03, 09-11, 09-25 and 10-01, i.e. roughly **weekly** releases adding a few to ~18 planets each, plus parameter updates and occasional false-positive redesignations. Polling once a day is plenty.
- Terms/attribution (https://exoplanetarchive.ipac.caltech.edu/docs/acknowledge.html): no formal terms-of-use or license text stated. Requested acknowledgement: "This research has made use of the NASA Exoplanet Archive, which is operated by the California Institute of Technology, under contract with the National Aeronautics and Space Administration under the Exoplanet Exploration Program." Cite Christiansen et al. (2025), Planetary Science Journal, and any literature behind data you display; some datasets (WASP, KELT, CUTE, INARA, ROME/REA) have extra acknowledgements.

## Implications for the aggregator

- Both sources suit a scheduled batch ingest (daily NeoWs feed for today..+6 days; daily or weekly archive pull) into Postgres rather than live proxying. A registered NeoWs key keeps a daily job far below limits.
- Store fetched-at timestamps plus the archive's own date columns so the UI can show real freshness.
- Show an attribution footer: NASA JPL CNEOS / NeoWs and the Exoplanet Archive acknowledgement sentence.

## Unverified / gaps

- NeoWs official OpenAPI spec not parsed; no official statement of NeoWs refresh cadence found (daily is inferred from `/stats.last_updated`).
- DEMO_KEY limit mismatch (documented 30/h, observed header 10).
- Archive docs give no throttling policy; behaviour under heavy load is unknown.
