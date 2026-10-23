// Validate configuration without opening a connection or printing credentials.
let valid = false;
try {
  const url = new URL(process.env.COLLECTOR_DATABASE_URL ?? '');
  valid = ['postgres:', 'postgresql:'].includes(url.protocol)
    && decodeURIComponent(url.username) === 'observatorio_collector'
    && Boolean(url.hostname)
    && !/-pooler(?:\.|$)/i.test(url.hostname);
} catch {
  // URL parser errors may contain credentials. Report only a fixed message below.
}

if (!valid) {
  console.error('COLLECTOR_DATABASE_URL must use the direct endpoint and observatorio_collector role.');
  process.exitCode = 1;
} else if (process.argv[2] === 'neows' && !process.env.NASA_API_KEY?.trim()) {
  console.error('NASA_API_KEY is required for NeoWs.');
  process.exitCode = 1;
}
