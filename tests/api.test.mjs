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

test('C and C++ compile Unicode paths and names without modifying sources or losing local includes', { skip: process.platform !== 'win32' && 'Windows compiler path compatibility is required.' }, async t => {
  const directory = '中文 空格';
  const cFile = `${directory}/计算 示例.c`;
  const cppFile = `${directory}/计算 示例.cpp`;
  const files = {
    [`${directory}/values.h`]: '#define STUDIO_VALUE 42\n',
    [cFile]: '\uFEFF#include <stdio.h>\n#include "values.h"\nint main(void) { printf("Header: %d\\n", STUDIO_VALUE); puts(__FILE__); return 0; }\n',
    [cppFile]: '#include <iostream>\n#include "values.h"\nint main() { std::cout << "Header: " << STUDIO_VALUE << "\\n" << __FILE__ << "\\n"; }\n',
  };
  const fixture = await createFixture({ files });
  t.after(() => fixture.cleanup());
  await fixture.start();
  const state = (await fixture.call('state')).value;
  let checked = 0;
  for (const [tool, file] of [['c', cFile], ['cpp', cppFile]]) {
    if (!state.tools[tool]?.available) { t.diagnostic(`SKIP ${tool}: no usable compiler on this machine.`); continue; }
    const before = await fs.readFile(path.join(fixture.root, 'workspace', file));
    const started = await fixture.call('run', { path: file });
    assert.equal(started.status, 200);
    let run;
    await eventually(async () => { run = (await fixture.call('state')).value.run; return run?.id === started.value.id && run.phase === 'finished'; }, 40000);
    assert.equal(run.code, 0, `${tool} Unicode source failed: ${run.output}`);
    assert.match(run.output, /Header: 42/);
    assert.ok(run.output.includes(await fs.realpath(path.join(fixture.root, 'workspace', file))), `__FILE__ must retain the original source path: ${run.output}`);
    assert.deepEqual(await fs.readFile(path.join(fixture.root, 'workspace', file)), before);
    assert.equal((await fs.readdir(path.join(fixture.root, 'workspace', directory))).some(name => name.startsWith('.studio-build-')), false, 'Owned source and executable copies must be removed.');
    checked++;
  }
  if (!checked) t.skip('No supported C/C++ compiler is installed.');
});

test('failed C compilation cleans owned copies and reports the original Unicode file and line', { skip: process.platform !== 'win32' && 'Windows compiler path compatibility is required.' }, async t => {
  const file = '中文 空格/错误 示例.c';
  const source = 'int main(void) {\n    return missing_name;\n}\n';
  const fixture = await createFixture({ files: { [file]: source } });
  t.after(() => fixture.cleanup());
  await fixture.start();
  if (!(await fixture.call('state')).value.tools.c?.available) { t.skip('No supported C compiler is installed.'); return; }
  const started = await fixture.call('run', { path: file });
  let run;
  await eventually(async () => { run = (await fixture.call('state')).value.run; return run?.id === started.value.id && run.phase === 'finished'; }, 40000);
  assert.notEqual(run.code, 0);
  assert.ok(run.output.includes(path.basename(file)), 'Diagnostics must reference the original filename.');
  assert.match(run.output, /:2:\d+:\s*error/);
  assert.equal(run.output.includes('.studio-build-'), false);
  assert.equal(await fs.readFile(path.join(fixture.root, 'workspace', file), 'utf8'), source);
  assert.deepEqual(await fs.readdir(path.join(fixture.root, 'workspace', path.dirname(file))), [path.basename(file)]);
});
