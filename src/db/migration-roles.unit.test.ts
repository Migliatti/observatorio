import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('./migrations/0009_least_privilege_roles.ts', import.meta.url), 'utf8');

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
});
