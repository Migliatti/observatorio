import { createDatabase } from '../db/database.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../db/api-key.js';

export interface KeyCliDependencies {
  databaseUrl: string | undefined;
  log?: (message: string) => void;
  logError?: (message: string) => void;
  now?: () => Date;
}

/** Administrative CLI; create emits plaintext exactly once. */
export async function main(args: readonly string[], deps: KeyCliDependencies): Promise<number> {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const [command, value, ...extra] = args;
  if (extra.length || !((command === 'create' && value?.trim()) || (command === 'list' && !value) ||
      (command === 'revoke' && value && /^[1-9]\d*$/.test(value)))) {
    logError('Usage: npm run keys -- create <consumer> | list | revoke <id>');
    return 1;
  }
  if (!deps.databaseUrl || !/^postgres(ql)?:\/\/.+/.test(deps.databaseUrl)) {
    logError('KEYS_DATABASE_URL is missing or is not a postgres:// connection string. See .env.example.');
    return 1;
  }
  const db = createDatabase(deps.databaseUrl, { maxConnections: 1 });
  try {
    if (command === 'create') log(JSON.stringify(await createApiKey(db, value!, deps.now?.())));
    else if (command === 'list') log(JSON.stringify(await listApiKeys(db)));
    else {
      if (!await revokeApiKey(db, value!, deps.now?.())) {
        logError('API key not found or already revoked.');
        return 1;
      }
      log(JSON.stringify({ id: value, revoked: true }));
    }
    return 0;
  } catch {
    // Avoid disclosing database credentials or key material in operational errors.
    logError('API key operation failed.');
    return 1;
  } finally {
    await db.destroy();
  }
}
