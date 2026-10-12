# sources

HTTP clients for each fonte (native `fetch` with timeout and retry) plus pure parsers.
Parsers never touch the network, the database or the global clock.

NeoWs: `fetchNeoWs` requests today's UTC date through +6 days using the configured NASA key. `parseNeoWs` converts source strings into numeric kilometers and kilometers per second and derives dates from millisecond epochs. Repeated JPL ids and asteroid/date pairs use the last occurrence. See `fixtures/neows/README.md` for the recorded response and provenance.
