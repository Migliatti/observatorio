# NeoWs recorded response

`feed.json` is the complete, unmodified real NASA NeoWs response captured on 2026-10-12 from:

https://api.nasa.gov/neo/rest/v1/feed?start_date=2015-09-07&end_date=2015-09-08&api_key=DEMO_KEY

The public DEMO_KEY is the only key in the fixture. Distances and velocities remain strings, and approach epochs remain numbers in milliseconds. Tests make no NASA requests. Tests that revise predictions or add a rolling-window date explicitly modify this baseline in memory; those modifications are synthetic scenarios, not source captures.

Official feed documentation: https://api.nasa.gov/#asteroids-neows
