# Exoplanet Archive fixtures

Recorded responses of the TAP query in `../../exoplanet-archive.ts` (`select ... from pscomppars`, `format=json`).
Tests serve these instead of calling the NASA.

- `pscomppars.json`: five real rows recorded on 2026-10-09, including absent values (`null`).
- `pscomppars-later.json`: the same table on a later coleta: `K2-43 b` disappeared and the mass of `HD 2039 b` changed (edited by hand).
- `error-http-200.xml`: a VOTable query error, which the Archive may send with HTTP 200.
