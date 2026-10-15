import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('database package scripts', () => {
  it('uses MIGRATOR_DATABASE_URL for generated database types', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['db:codegen']).toContain('--url "env(MIGRATOR_DATABASE_URL)"');
  });
});
