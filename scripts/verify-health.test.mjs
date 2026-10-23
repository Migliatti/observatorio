import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { REQUEST_TIMEOUT_MS, verifyHealth } from './verify-health.mjs';

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

async function localProbe(t, overrides = {}, options = {}) {
  const health = await fixture('health');
  const status = await fixture('status');
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] });
    const route = overrides[req.url] ?? { body: req.url === '/health' ? health : req.url === '/v1/status' ? status : 'OK' };
    if (route.hang) return;
    const send = () => {
      res.writeHead(route.code ?? 200, { 'Content-Type': route.type ?? 'application/json' });
      if (route.hangBody) { res.flushHeaders(); return; }
      res.end(route.raw ?? JSON.stringify(route.body));
    };
    if (route.delay) setTimeout(send, route.delay); else send();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    run: () => verifyHealth({ baseUrl, successUrl: `${baseUrl}/success`, timeoutMs: 1000, ...options }),
  };
}

test('success uses public routes in order and signals once; latest failed run can still be fresh', async (t) => {
  const probe = await localProbe(t);
  await probe.run();
  assert.deepEqual(probe.requests.map((req) => req.path), ['/health', '/v1/status', '/success']);
  assert.ok(probe.requests.every((req) => req.authorization === undefined && req.apiKey === undefined));
  assert.equal(REQUEST_TIMEOUT_MS, 120_000);
});

for (const [name, change] of [
  ['stale source', (body) => { body.meta.sources[1].stale = true; }],
  ['no successful collection', (body) => { body.meta.sources[1].data_as_of = null; }],
  ['missing source', (body) => { body.meta.sources.pop(); }],
  ['empty sources', (body) => { body.meta.sources = []; }],
  ['duplicate source', (body) => { body.meta.sources[1] = body.meta.sources[0]; }],
  ['unknown source', (body) => { body.meta.sources[1].name = 'unknown'; }],
  ['missing run source', (body) => { body.data.sources.pop(); }],
  ['invalid timestamp', (body) => { body.meta.sources[0].data_as_of = 'yesterday'; }],
  ['missing stale', (body) => { delete body.meta.sources[0].stale; }],
  ['nonboolean stale', (body) => { body.meta.sources[0].stale = 'false'; }],
  ['missing attribution', (body) => { delete body.meta.sources[0].attribution; }],
  ['missing run status', (body) => { delete body.data.sources[0].last_run_status; }],
  ['invalid run timestamp', (body) => { body.data.sources[0].last_run_finished_at = 123; }],
  ['invalid envelope', (body) => { delete body.meta; }],
]) {
  test(`rejects ${name} without sending success signal`, async (t) => {
    const body = await fixture('status');
    change(body);
    const probe = await localProbe(t, { '/v1/status': { body } });
    await assert.rejects(probe.run());
    assert.deepEqual(probe.requests.map((req) => req.path), ['/health', '/v1/status']);
  });
}

for (const path of ['/health', '/v1/status']) {
  for (const [name, route] of [
    ['HTTP 503', { code: 503 }],
    ['HTTP redirect', { code: 302 }],
    ['HTTP 204', { code: 204 }],
    ['malformed JSON', { raw: '{' }],
    ['HTML', { raw: '<html>Unavailable</html>', type: 'text/html' }],
    ['timeout before headers', { hang: true }],
    ['timeout during body', { hangBody: true }],
  ]) {
    test(`${path}: rejects ${name}`, async (t) => {
      const probe = await localProbe(t, { [path]: route }, { timeoutMs: 100 });
      await assert.rejects(probe.run(), /request failed/);
      assert.ok(!probe.requests.some((req) => req.path === '/success'));
    });
  }
}

test('rejects health with an unexpected status', async (t) => {
  const probe = await localProbe(t, { '/health': { body: { status: 'down' } } });
  await assert.rejects(probe.run(), /expected status ok/);
  assert.equal(probe.requests.length, 1);
});

test('accepts a delayed response within the timeout', async (t) => {
  const probe = await localProbe(t, { '/health': { body: await fixture('health'), delay: 50 } });
  await probe.run();
});

test('accepts nullable latest run fields with fresh successful metadata', async (t) => {
  const body = await fixture('status');
  body.data.sources[0].last_run_status = null;
  body.data.sources[0].last_run_finished_at = null;
  const probe = await localProbe(t, { '/v1/status': { body } });
  await probe.run();
});

for (const route of [{ code: 503 }, { hang: true }]) {
  test(`failure to signal success fails the check (${route.code ?? 'timeout'})`, async (t) => {
    const probe = await localProbe(t, { '/success': route }, { pingTimeoutMs: 100 });
    await assert.rejects(probe.run(), /Healthchecks success signal: request failed/);
  });
}

test('configuration fails before any request and does not reveal secret values', async (t) => {
  const probe = await localProbe(t, {}, { successUrl: 'https://user:secret@example.invalid/private-token' });
  await assert.rejects(probe.run(), (error) => !/secret|private-token/.test(error.message));
  assert.equal(probe.requests.length, 0);
});

test('missing heartbeat configuration fails before probing', async (t) => {
  const probe = await localProbe(t, {}, { successUrl: undefined });
  await assert.rejects(probe.run(), /HEALTHCHECKS_VERIFY_URL: missing or invalid URL/);
  assert.equal(probe.requests.length, 0);
});
