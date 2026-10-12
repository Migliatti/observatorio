import { main } from './main.js';

process.exitCode = await main(process.argv.slice(2), { databaseUrl: process.env.DATABASE_URL });
