import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { readAIStream } from '../ai-stream.mjs';
import { createBackupStore } from '../backup.mjs';
import { createFixture, listen, closeServer, eventually } from './helpers.mjs';

const frames = items => items.map(item => `data: ${typeof item === 'string' ? item : JSON.stringify(item)}\r\n\r\n`).join('');
function streamed(items, width = 1) {
  const bytes = Buffer.from(frames(items));
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += width) controller.enqueue(bytes.subarray(i, i + width)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
test('chat stream preserves Chinese split across UTF-8 bytes and CRLF boundaries', async () => {
  const deltas = []; const result = await readAIStream(streamed([{ choices: [{ delta: { content: '你好' } }] }, { choices: [{ delta: { content: '，世界' }, finish_reason: 'stop' }] }, { usage: { total_tokens: 4 }, choices: [] }, '[DONE]']), 'chat', value => deltas.push(value));
  assert.equal(result.text, '你好，世界'); assert.deepEqual(deltas, ['你好', '，世界']); assert.equal(result.usage.total_tokens, 4);
});
test('Responses and Anthropic streams collect only visible text and usage', async () => {
  const response = await readAIStream(streamed([{ type: 'response.output_text.delta', delta: 'Answer' }, { type: 'response.completed', response: { usage: { total_tokens: 5 } } }], 7), 'responses', () => {});
  assert.equal(response.text, 'Answer'); assert.equal(response.usage.total_tokens, 5);
  const anthropic = await readAIStream(streamed([{ type: 'message_start', message: { usage: { input_tokens: 2 } } }, { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private' } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Visible' } }, { type: 'message_delta', usage: { output_tokens: 3 } }, { type: 'message_stop' }]), 'anthropic', () => {});
  assert.equal(anthropic.text, 'Visible'); assert.deepEqual(anthropic.usage, { input_tokens: 2, output_tokens: 3 });
});
test('JSON success is accepted without a second provider request', async () => {
  const output = []; const result = await readAIStream(Response.json({ choices: [{ message: { content: 'Fallback' } }] }), 'chat', text => output.push(text));
  assert.equal(result.mode, 'standard'); assert.deepEqual(output, ['Fallback']);
});
test('partial streams and provider errors remain failures', async () => {
  await assert.rejects(readAIStream(streamed([{ choices: [{ delta: { content: 'Partial' } }] }]), 'chat', () => {}), /提前结束/);
  await assert.rejects(readAIStream(streamed([{ type: 'error', error: { message: 'denied' } }]), 'responses', () => {}), /denied/);
});
test('encrypted backup allowlist, version backups and path guards', async t => {
  const fixture = await createFixture(); t.after(() => fixture.cleanup());
  const dir = path.join(fixture.root, 'data'); await fs.writeFile(path.join(dir, 'running.json'), '{"control":"private-control"}');
  const protect = async (value, decrypt) => decrypt ? Buffer.from(value, 'base64').toString() : Buffer.from(value).toString('base64');
  const backup = createBackupStore({ dataDir: dir, version: '0.3.0', protect }); await backup.beforeUpgrade(); await backup.beforeUpgrade();
  assert.equal((await backup.list()).length, 1);
  const exported = await backup.capture(); const files = await backup.decode(exported.backup);
  assert.deepEqual(Object.keys(files), ['settings.json']); assert.equal(files['running.json'], undefined);
  await assert.rejects(backup.load('../settings.json'), /名称无效/); await assert.rejects(backup.decode({ version: 999 }), /有效/);
});
test('stream API retries only explicit unsupported-stream rejection and supports cancellation', async t => {
  let attempts = 0; let canceled = false;
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw); attempts++;
    if (body.messages.at(-1).content === 'slow') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(frames([{ choices: [{ delta: { content: 'start' } }] }]));
      res.on('close', () => { canceled = true; }); return;
    }
    if (body.stream) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'stream is not supported' } })); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'fallback reply' } }] })); }
  });
  const base = await listen(provider); t.after(() => closeServer(provider));
  const fixture = await createFixture({ settings: { baseUrl: base } }); t.after(() => fixture.cleanup()); await fixture.start();
  const headers = { 'X-Studio-Token': fixture.token, 'Content-Type': 'application/json' };
  const response = await fetch(fixture.base + '/api/ai/stream', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }) });
  assert.match(await response.text(), /fallback reply/); assert.equal(attempts, 2);
  const controller = new AbortController(); const slow = await fetch(fixture.base + '/api/ai/stream', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'slow' }] }), signal: controller.signal });
  await slow.body.getReader().read(); controller.abort(); await eventually(() => canceled);
});
test('Windows backup restores encrypted API settings, locale and mentor progress without editing code', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await createFixture({ files: { 'main.py': 'print(42)\n' } }); t.after(() => fixture.cleanup());
  // Windows runner TEMP may use an 8.3 alias; match the server's canonical workspace.
  const workspace = await fs.realpath(path.join(fixture.root, 'workspace'));
  const key = crypto.createHash('sha256').update(workspace.toLowerCase()).digest('hex');
  const savedTask = { id: 'saved-task', title: 'Preserved task', task: 'Learn sums', steps: [{ id: 'step-1', title: 'Sum', goal: 'Sum values', hint: 'Accumulate', acceptance: 'Correct sum', completed: false }], currentStep: 0, status: 'paused', options: { autoMode: 'manual', minInterval: 20000, idleDelay: 5000, maxAutoChecksPerHour: 30 }, metrics: { requests: 2, reportedTokens: 12, usageResponses: 1 }, history: [], automaticRequests: [], revision: 1 };
  await fs.writeFile(path.join(fixture.root, 'data/mentor-sessions.json'), JSON.stringify({ version: 1, sessions: { [key]: savedTask } })); await fixture.start();
  assert.equal((await fixture.call('settings', { baseUrl: 'http://127.0.0.1:9', key: 'test-only-key', locale: 'en' })).status, 200);
  const exported = await fixture.call('backups/export', {}); assert.equal(exported.status, 200); assert.ok(exported.value.backup.encryptedData); assert.ok(!JSON.stringify(exported.value).includes('test-only-key'));
  await fixture.call('settings', { clearKey: true, locale: 'zh-CN' });
  await fixture.call('mentor/reset', {});
  const restored = await fixture.call('backups/import', { backup: exported.value.backup }); assert.equal(restored.status, 200);
  const state = (await fixture.call('state')).value; assert.equal(state.settings.locale, 'en'); assert.equal(state.settings.hasKey, true); assert.equal(state.settings.encryptedKey, undefined);
  assert.equal(await fs.readFile(path.join(fixture.root, 'workspace/main.py'), 'utf8'), 'print(42)\n'); assert.ok((await fixture.call('backups')).value.backups.some(x => x.reason === 'before-restore'));
  assert.equal((await fixture.call('mentor')).value.session.id, 'saved-task');
  const oldHome = path.join(fixture.root, 'old-workbench'); await fs.mkdir(path.join(oldHome, 'data'), { recursive: true });
  for (const name of ['settings.json', 'mentor-sessions.json']) await fs.copyFile(path.join(fixture.root, 'data', name), path.join(oldHome, 'data', name));
  await fixture.call('settings', { clearKey: true, locale: 'zh-CN' }); await fixture.call('mentor/reset', {});
  assert.equal((await fixture.call('backups/migrate', { path: oldHome })).status, 200);
  assert.equal((await fixture.call('state')).value.settings.hasKey, true); assert.equal((await fixture.call('mentor')).value.session.id, 'saved-task');
});
