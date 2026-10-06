import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const SECRET_KEYS = new Set(['DATABASE_URL']);

export const ConfigSchema = Type.Object({
  DATABASE_URL: Type.String({
    pattern: '^postgres(ql)?://.+',
    description: 'Postgres connection string (postgres://user:pass@host:port/db)',
  }),
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 3000 }),
  HOST: Type.String({ minLength: 1, default: '0.0.0.0' }),
  LOG_LEVEL: Type.Enum([...LOG_LEVELS], { default: 'info' }),
});

export type Config = Static<typeof ConfigSchema>;

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Validates environment variables against {@link ConfigSchema}.
 * Unknown variables are ignored, defaults are applied and numeric strings are converted.
 * Throws {@link ConfigError} listing every problem at once.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const known = Object.fromEntries(
    Object.keys(ConfigSchema.properties)
      .filter((key) => env[key] !== undefined && env[key] !== '')
      .map((key) => [key, env[key]]),
  );
  const value = Value.Convert(ConfigSchema, Value.Default(ConfigSchema, known));

  if (Value.Check(ConfigSchema, value)) {
    return value;
  }

  const problems = new Map<string, string>();
  for (const error of Value.Errors(ConfigSchema, value)) {
    if (error.keyword === 'required') {
      const missing = (error.params as { requiredProperties?: string[] }).requiredProperties ?? [];
      for (const name of missing) {
        problems.set(name, `${name} is required`);
      }
      continue;
    }
    const name = error.instancePath.replace(/^\//, '');
    if (problems.has(name)) continue;
    const allowed = (error.params as { allowedValues?: unknown[] }).allowedValues;
    const detail = allowed ? `must be one of ${allowed.join(', ')}` : error.message;
    // Never echo values that may carry credentials.
    const received = SECRET_KEYS.has(name) ? '' : ` (received ${JSON.stringify(env[name])})`;
    problems.set(name, `${name} ${detail}${received}`);
  }
  throw new ConfigError([...problems.values()]);
}
