import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('./migrations/0009_least_privilege_roles.ts', import.meta.url), 'utf8');
const followupPath = new URL('./migrations/0010_namespace_existing_roles.ts', import.meta.url);

describe('least-privilege role migration', () => {
  it('creates and alters only roles namespaced to this application', () => {
    for (const role of ['migrator', 'collector', 'api', 'key_admin']) {
      const namespacedRole = `observatorio_${role}`;

      expect(migration).toContain(`rolname = '${namespacedRole}'`);
      expect(migration).toContain(`create role ${namespacedRole}`);
      expect(migration).toContain(`alter role ${namespacedRole}`);
      expect(migration).not.toMatch(new RegExp(`(?:create|alter) role ${role}\\b`));
    }
  });

  it('includes a forward migration for existing databases', () => {
    expect(existsSync(followupPath)).toBe(true);
  });
});

describe.skipIf(!existsSync(followupPath))('namespace migration for existing databases', () => {
  it('adopts existing objects without modifying generic cluster roles', () => {
    const followup = readFileSync(followupPath, 'utf8').toLowerCase();
    for (const role of ['migrator', 'collector', 'api', 'key_admin']) {
      const namespacedRole = `observatorio_${role}`;
      expect(followup).toContain(`create role ${namespacedRole}`);
      expect(followup).toContain(`alter role ${namespacedRole}`);
    }
    expect(followup).toContain('rolcreaterole');
    expect(followup).toContain('rolsuper');
    expect(followup).toContain('alter table public.ingestion_run owner to observatorio_migrator');
    expect(followup).toContain('alter table public.api_key owner to observatorio_migrator');
    expect(followup).toContain('alter table public.kysely_migration owner to observatorio_migrator');
    expect(followup).toContain('alter sequence public.api_key_id_seq owner to observatorio_migrator');
    expect(followup).toContain('grant update (last_used_at) on table public.api_key to observatorio_api');
    expect(followup).not.toMatch(/\b(?:create|alter|drop)\s+role\s+(?:migrator|collector|api|key_admin)\b/);
    expect(followup).not.toMatch(/\b(?:migrator|collector|api|key_admin)\b/);
  });
});
