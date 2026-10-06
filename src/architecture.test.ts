// Module boundaries (also enforced by Oxlint's no-restricted-imports):
// `api` and `collect` never import each other; `domain` and `sources` stay pure.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));
const MODULES = ['sources', 'db', 'collect', 'api', 'domain'] as const;
type Module = (typeof MODULES)[number];

const FORBIDDEN: Record<Module, Module[]> = {
  api: ['collect'],
  collect: ['api'],
  domain: ['api', 'collect', 'db', 'sources'],
  sources: ['api', 'collect', 'db'],
  db: ['api', 'collect'],
};

function moduleOf(file: string): string | undefined {
  return relative(SRC, file).split(sep)[0];
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers = source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g);
  return [...specifiers].map((match) => match[1]!).filter((specifier) => specifier.startsWith('.'));
}

describe('module structure', () => {
  it.each(MODULES)('src/%s exists', (name) => {
    expect(() => readdirSync(join(SRC, name))).not.toThrow();
  });

  it.each(MODULES)('src/%s respects its import boundaries', (name) => {
    const files = readdirSync(join(SRC, name), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .map((file) => join(SRC, name, file));

    const violations = files.flatMap((file) =>
      importsOf(file)
        .filter((specifier) => {
          const target = moduleOf(resolve(dirname(file), specifier));
          return FORBIDDEN[name].some((forbidden) => forbidden === target);
        })
        .map((specifier) => `${relative(SRC, file)} imports ${specifier}`),
    );

    expect(violations).toEqual([]);
  });
});
