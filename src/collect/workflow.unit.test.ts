import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const workflow = readFileSync(resolve(root, '.github/workflows/collect.yml'), 'utf8');
const validator = resolve(root, '.github/scripts/validate-collector-env.mjs');
const signal = resolve(root, '.github/scripts/signal-collection.sh');
const direct = 'postgres://observatorio_collector:private-password@ep-example.neon.tech/db?sslmode=require';
const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function stub(name: string, body: string) {
  const folder = mkdtempSync(join(tmpdir(), 'collection-workflow-'));
  folders.push(folder);
  writeFileSync(join(folder, name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
  return folder;
}

function job(name: string) {
  const section = workflow.split(`\n  ${name}:\n`)[1];
  if (!section) throw new Error(`Missing job ${name}`);
  return section.split(/\n  [a-z][a-z-]*:\n/)[0]!;
}

function validate(url: string, source = 'exoplanet-archive', key = '') {
  return spawnSync(process.execPath, [validator, source], {
    encoding: 'utf8', env: { COLLECTOR_DATABASE_URL: url, NASA_API_KEY: key },
  });
}

describe('daily collection workflow contract', () => {
  it('schedules once daily, allows manual runs, and grants read-only contents', () => {
    expect(workflow).toMatch(/on:\n  schedule:\n    - cron: '17 6 \* \* \*'/);
    expect(workflow).toContain('  workflow_dispatch:');
    expect(workflow).toMatch(/permissions:\n  contents: read\n/);
    expect(workflow).not.toMatch(/\b(push|pull_request|write-all|continue-on-error)\b/);
    expect(workflow).toMatch(/concurrency:\n  group: observatorio-collection\n  cancel-in-progress: false/);
    expect(workflow).toMatch(/defaults:\n  run:\n    shell: bash/);
  });

  it.each(['exoplanet-archive', 'neows'])('runs %s independently on main with step-scoped secrets', (source) => {
    const body = job(source);
    expect(body).toContain("if: github.ref == 'refs/heads/main'");
    expect(body).not.toContain('needs:');
    expect(body).toContain('timeout-minutes: 30');
    expect(body).toContain('persist-credentials: false');
    expect(body).toContain('node-version: 24');
    expect(body).toContain('- run: npm ci');
    expect(body).toContain('          COLLECTOR_DATABASE_URL: ${{ secrets.COLLECTOR_DATABASE_URL }}');
    expect(body).toContain(`node .github/scripts/validate-collector-env.mjs ${source}\n          npm run collect -- ${source}`);
    expect(body).not.toContain('HEALTHCHECKS_COLLECT_URL');
    expect(body.includes('NASA_API_KEY: ${{ secrets.NASA_API_KEY }}')).toBe(source === 'neows');
  });

  it('has exactly one signal path, gated on both successful sources', () => {
    expect(workflow.split('\njobs:\n')[1]!.match(/^  [a-z][a-z-]*:$/gm)).toEqual([
      '  exoplanet-archive:', '  neows:', '  signal:',
    ]);
    const body = job('signal');
    expect(body).toContain('needs: [exoplanet-archive, neows]');
    expect(body).toContain("if: needs.exoplanet-archive.result == 'success' && needs.neows.result == 'success'");
    expect(body).not.toMatch(/always\(|continue-on-error|COLLECTOR_DATABASE_URL|NASA_API_KEY/);
    expect(body).toContain('HEALTHCHECKS_COLLECT_URL: ${{ secrets.HEALTHCHECKS_COLLECT_URL }}');
    expect(body).toContain('run: bash .github/scripts/signal-collection.sh');
  });

  it.each(['exoplanet-archive', 'neows'])('preserves a failing CLI exit status for %s', (source) => {
    const folder = stub('npm', 'exit 23');
    const command = job(source).split('        run: |\n')[1]!.trim().replaceAll('\n          ', '\n');
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', command], {
      cwd: root, encoding: 'utf8',
      env: { PATH: folder + delimiter + process.env.PATH, COLLECTOR_DATABASE_URL: direct, NASA_API_KEY: 'fake-key' },
    });
    expect(result.status).toBe(23);
  });

  it.each(['exoplanet-archive', 'neows'])('does not invoke the CLI after failed preflight for %s', (source) => {
    const folder = stub('npm', 'echo SHOULD-NOT-RUN; exit 0');
    const command = job(source).split('        run: |\n')[1]!.trim().replaceAll('\n          ', '\n');
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', command], {
      cwd: root, encoding: 'utf8',
      env: { PATH: folder + delimiter + process.env.PATH },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });
});

describe('collection configuration preflight (no connections)', () => {
  it('accepts the direct collector role for both sources', () => {
    expect(validate(direct).status).toBe(0);
    expect(validate(direct, 'neows', 'fake-key').status).toBe(0);
  });

  it.each([
    '', 'malformed-private-password',
    direct.replace('postgres:', 'https:'),
    direct.replace('observatorio_collector', 'observatorio_migrator'),
    direct.replace('ep-example.', 'ep-example-pooler.'),
    direct.replace('observatorio_collector', '%invalid'),
  ])('rejects invalid collector configuration without leaking it: case %#', (url) => {
    const result = validate(url);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('COLLECTOR_DATABASE_URL must use the direct endpoint and observatorio_collector role.\n');
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('private-password');
  });

  it('requires the NASA key only for NeoWs', () => {
    expect(validate(direct).status).toBe(0);
    expect(validate(direct, 'neows', '   ').status).toBe(1);
  });

  it('the actual CLI exits nonzero before any connection when configuration is missing', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/collect/cli.ts', 'neows'], {
      cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('COLLECTOR_DATABASE_URL is missing');
  });
});

describe('shared Healthchecks signal (stub curl, no network)', () => {
  it.each(['', 'http://example.invalid/private-check'])('fails closed for missing/non-HTTPS URL: case %#', (url) => {
    const folder = stub('curl', 'echo SHOULD-NOT-RUN; exit 0');
    const result = spawnSync('/bin/bash', [signal], {
      encoding: 'utf8', env: { PATH: folder, HEALTHCHECKS_COLLECT_URL: url },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('private-check');
  });

  it.each([0, 22, 28, 6])('handles curl exit %i without exposing the URL', (code) => {
    const folder = stub('curl', `printf '%s\\n' "$@" > "$CAPTURE"\necho private-check >&2\nexit ${code}`);
    const capture = join(folder, 'args');
    const result = spawnSync('/bin/bash', [signal], {
      encoding: 'utf8',
      env: { PATH: folder, CAPTURE: capture, HEALTHCHECKS_COLLECT_URL: 'https://example.invalid/private-check' },
    });
    expect(result.status).toBe(code === 0 ? 0 : 1);
    expect(result.stdout + result.stderr).not.toContain('private-check');
    const args = readFileSync(capture, 'utf8');
    for (const option of ['--fail', '--silent', '--output\n/dev/null', '--connect-timeout\n10', '--max-time\n30', '--retry\n3', '--retry-max-time\n90', '--proto\n=https']) {
      expect(args).toContain(option);
    }
    expect(args).not.toContain('--location');
    expect(args.trim().split('\n').at(-1)).toBe('https://example.invalid/private-check');
  });
});
