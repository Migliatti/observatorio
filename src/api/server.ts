// API entrypoint: validates configuration before anything else and refuses to boot when it is invalid.
import { createDatabase } from '../db/database.js';
import { buildApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`${error.message}\nRefusing to start. See .env.example.`);
    process.exit(1);
  }
  throw error;
}

const db = createDatabase(config.DATABASE_URL);
const app = await buildApp({
  db,
  rateLimits: {
    ip: { capacity: config.RATE_LIMIT_IP_CAPACITY, windowSeconds: config.RATE_LIMIT_IP_WINDOW_SECONDS },
    apiKey: { capacity: config.RATE_LIMIT_KEY_CAPACITY, refillPerSecond: config.RATE_LIMIT_KEY_REFILL_PER_SECOND },
  },
  corsOrigins: config.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
  logger: {
    level: config.LOG_LEVEL,
    redact: ['req.headers.authorization'],
  },
});

app.addHook('onClose', async () => {
  await db.destroy();
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    // A repeated signal means the graceful close is stuck: stop waiting.
    app.log.warn(`Received ${signal} again during shutdown, forcing exit`);
    process.exit(1);
  }
  shuttingDown = true;
  app.log.info(`Received ${signal}, shutting down`);
  app.close().then(
    () => process.exit(0),
    (error: unknown) => {
      app.log.error(error, 'Error during shutdown');
      process.exit(1);
    },
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => shutdown(signal));
}

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
