import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFixture, listen, closeServer, sleep, eventually } from './helpers.mjs';

function mockProvider(records, { gate, shouldFail = () => false } = {}) {
  return http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk.toString();
      const input = JSON.parse(raw);
      records.push({ input, url: req.url, authorization: req.headers.authorization });
      if (gate) await gate;
      if (shouldFail(input)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid key studio-test-only-fake-key' } }));
        return;
      }
      const text = 'Local mock response';
      const response = req.url.endsWith('/responses')
        ? { output: [{ content: [{ type: 'output_text', text }] }] }
        : req.url.endsWith('/messages')
          ? { content: [{ type: 'text', text }] }
          : { choices: [{ message: { content: text } }] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
}

test('local API requires its session token and rejects foreign origins and file traversal', async t => {
  const fixture = await createFixture({ files: { 'main.py': 'print("local")\n' } });
  t.after(() => fixture.cleanup());
  await fixture.start();
  assert.equal((await fetch(`${fixture.base}/api/state`)).status, 403);
  assert.equal((await fixture.call('files?path=../../server.mjs')).status, 403);
  assert.equal((await fixture.call('run', { path: 'main.py' }, { headers: { Origin: 'https://example.com' } })).status, 403);
  const state = await fixture.call('state');
  assert.equal(state.status, 200);
  assert.equal(state.value.settings.hasKey, false);
  assert.equal('encryptedKey' in state.value.settings, false);
  assert.equal(fixture.log, '');
});

test('file saves remain inside the isolated workspace and unavailable tools are reported', async t => {
  const fixture = await createFixture({ files: { 'main.py': 'print(1)\n' } });
  t.after(() => fixture.cleanup());
  await fixture.start();
  assert.equal((await fixture.call('files', { path: 'main.py', content: 'print(2)\n' })).status, 200);
  assert.equal(await fs.readFile(path.join(fixture.root, 'workspace/main.py'), 'utf8'), 'print(2)\n');
  const result = await fixture.call('settings', { tools: { python: path.join(fixture.root, 'missing-python'), c: '', cpp: '' } });
  assert.equal(result.status, 200);
  assert.equal(result.value.tools.python.available, false);
  assert.equal((await fixture.call('run', { path: 'main.py' })).status, 200);
  await eventually(async () => (await fixture.call('state')).value.run?.phase === 'finished');
  const run = (await fixture.call('state')).value.run;
  assert.equal(run.code, -1);
  assert.match(run.output, /运行环境未检测到/);
});

test('Chat Completions, Responses and Anthropic adapters work entirely with local mocks', async t => {
  const records = [];
  const mock = mockProvider(records);
  const mockBase = await listen(mock);
  t.after(() => closeServer(mock));
  const fixture = await createFixture({ settings: { baseUrl: `${mockBase}/v1` } });
  t.after(() => fixture.cleanup());
  await fixture.start();
  for (const [protocol, suffix] of [['chat', '/chat/completions'], ['responses', '/responses'], ['anthropic', '/messages']]) {
    assert.equal((await fixture.call('settings', { protocol })).status, 200);
    const response = await fixture.call('ai', { kind: 'test' });
    assert.equal(response.status, 200);
    assert.equal(response.value.text, 'Local mock response');
    assert.ok(records.at(-1).url.endsWith(suffix));
    assert.equal(records.at(-1).authorization, undefined);
  }
  assert.equal(records.length, 3);
  assert.equal(fixture.log, '');
});

test('Windows protects keys at rest, redacts provider errors and clears keys on endpoint changes', { skip: process.platform !== 'win32' && 'Windows DPAPI is required.' }, async t => {
  const records = [];
  const mock = mockProvider(records, { shouldFail: input => JSON.stringify(input).includes('force-auth-failure') });
  const mockBase = await listen(mock);
  t.after(() => closeServer(mock));
  const fixture = await createFixture({ settings: { baseUrl: `${mockBase}/v1` } });
  t.after(() => fixture.cleanup());
  await fixture.start();
  assert.equal((await fixture.call('settings', { key: 'studio-test-only-fake-key', anonymous: false })).status, 200);
  const settings = await fs.readFile(path.join(fixture.root, 'data/settings.json'), 'utf8');
  assert.equal(settings.includes('studio-test-only-fake-key'), false);
  assert.equal((await fixture.call('state')).value.settings.hasKey, true);
  const response = await fixture.call('ai', { kind: 'chat', messages: [{ role: 'user', content: 'force-auth-failure' }] });
  assert.equal(response.status, 502);
  assert.match(response.value.error, /401/);
  assert.equal(response.value.error.includes('studio-test-only-fake-key'), false);
  assert.equal(records.at(-1).authorization, 'Bearer studio-test-only-fake-key');
  assert.equal((await fixture.call('settings', { baseUrl: `${mockBase}/different` })).status, 200);
  assert.equal((await fixture.call('state')).value.settings.hasKey, false);
});

test('in-flight API requests keep their original endpoint, model and Windows credential', { skip: process.platform !== 'win32' && 'Windows DPAPI is required.' }, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const records = [[], []];
  const mocks = [mockProvider(records[0], { gate }), mockProvider(records[1])];
  const bases = await Promise.all(mocks.map(mock => listen(mock)));
  t.after(async () => { release(); await Promise.all(mocks.map(mock => closeServer(mock))); });
  const fixture = await createFixture({ settings: { baseUrl: `${bases[0]}/v1`, model: 'model-before' } });
  t.after(() => fixture.cleanup());
  await fixture.start();
  assert.equal((await fixture.call('settings', { key: 'studio-test-only-fake-key', anonymous: false })).status, 200);
  const pending = fixture.call('ai', { kind: 'chat', messages: [{ role: 'user', content: 'snapshot test' }] });
  // Settings may change while key decryption or the provider response is pending.
  await sleep(50);
  assert.equal((await fixture.call('settings', { baseUrl: `${bases[1]}/v1`, model: 'model-after', clearKey: true, anonymous: true })).status, 200);
  release();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.value.model, 'model-before');
  assert.equal(records[1].length, 0);
  assert.equal(records[0].length, 1);
  assert.equal(records[0][0].input.model, 'model-before');
  assert.equal(records[0][0].authorization, 'Bearer studio-test-only-fake-key');
});
