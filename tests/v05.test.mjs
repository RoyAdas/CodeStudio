import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFixture, eventually } from './helpers.mjs';
import { createUpdates } from '../updates.mjs';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { listen, closeServer } from './helpers.mjs';

test('multiple encrypted AI profiles route chat, completion and mentor independently and learning recaps require saving', async t => {
  const requests = [];
  const provider = http.createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body); const system = body.messages[0].content;
    const answer = system.includes('把任务拆成') ? JSON.stringify({ title: 'Practice', overview: 'Learn', steps: [{ title: 'First', goal: 'Write a function', hint: 'Start small', acceptance: 'Correct output' }] }) : system.includes('只检查当前步骤') ? JSON.stringify({ status: 'needs_fix', note: 'Handle empty input', hint: 'Try an empty list', evidence: [] }) : 'Model ' + body.model;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
  });
  const base = await listen(provider); t.after(() => closeServer(provider)); const fixture = await createFixture({ files: { 'main.py': 'print(1)\n' }, settings: { baseUrl: base } }); t.after(() => fixture.cleanup()); await fixture.start();
  const first = await fixture.call('profiles', { name: 'Fast', protocol: 'chat', baseUrl: base, model: 'fast-model', key: 'test-only-profile-secret', anonymous: false }); assert.equal(first.status, 200); const fast = first.value.profiles[0]; assert.equal(fast.hasKey, true); assert.ok(!JSON.stringify(first.value).includes('test-only-profile-secret')); assert.equal(fast.encryptedKey, undefined);
  const second = await fixture.call('profiles', { name: 'Teacher', protocol: 'chat', baseUrl: base, model: 'teacher-model', anonymous: true }); const teacher = second.value.profiles.find(item => item.name === 'Teacher');
  await fixture.call('profiles', { action: 'route', role: 'complete', id: fast.id }); await fixture.call('profiles', { action: 'route', role: 'mentor', id: teacher.id }); await fixture.call('profiles', { action: 'route', role: 'chat', id: teacher.id });
  assert.equal((await fixture.call('ai', { kind: 'complete', path: 'main.py', language: 'python', prefix: '', suffix: '' })).value.model, 'fast-model');
  assert.equal((await fixture.call('ai', { kind: 'chat', messages: [{ role: 'user', content: 'hello' }] })).value.model, 'teacher-model');
  const context = { activePath: 'main.py', files: [{ path: 'main.py', code: 'print(1)\n' }] };
  await fixture.call('mentor/start', { task: 'Learn functions', context }); await fixture.call('mentor/check', { trigger: 'manual', context }); assert.equal(requests.at(-1).model, 'teacher-model');
  const learning = (await fixture.call('learning')).value; assert.equal(learning.tasks.length, 1); assert.equal(learning.tasks[0].mistakes.length, 1);
  const draft = await fixture.call('learning/recap', { id: learning.tasks[0].id }); assert.match(draft.value.text, /teacher-model/); assert.equal((await fixture.call('learning')).value.tasks[0].recap, undefined);
  await fixture.call('learning/save', { id: learning.tasks[0].id, text: 'I learned empty input handling.' }); assert.equal((await fixture.call('learning')).value.tasks[0].recap, 'I learned empty input handling.');
  const disk = JSON.parse(await fs.readFile(path.join(fixture.root, 'data/settings.json'), 'utf8')); assert.ok(disk.profiles[0].encryptedKey); assert.ok(!JSON.stringify(disk).includes('test-only-profile-secret'));
});
test('installed version families retain the old version for rollback and registered versions are validated', async t => {
  const fixture = await createFixture(); t.after(() => fixture.cleanup());
  await fs.writeFile(path.join(fixture.root, 'BUILD.json'), JSON.stringify({ name: 'CodeStudio', version: '0.4.0', platform: 'windows-x64' }));
  const newer = path.join(fixture.root, 'versions/0.5.0'); await fs.mkdir(path.join(newer, 'data'), { recursive: true }); await fs.writeFile(path.join(newer, 'data/install-family.json'), JSON.stringify({ root: fixture.root }));
  const updater = createUpdates({ home: newer, version: '0.5.0', dataDir: path.join(newer, 'data'), backups: {} }); const versions = await updater.list(); assert.ok(versions.some(item => item.version === '0.4.0' && !item.current)); assert.ok(versions.some(item => item.version === '0.5.0' && item.current));
  await assert.rejects(updater.register({ path: path.join(fixture.root, 'workspace') }));
});

test('project search uses drafts, excludes secrets and previews literal multi-file replacement', async t => {
  const fixture = await createFixture({ files: { 'main.py': 'value = 1\nprint(value)\n', 'helper.py': 'value = 2\n', '.env': 'value=private\n' } }); t.after(() => fixture.cleanup()); await fixture.start();
  const result = await fixture.call('search', { query: 'value', replacement: 'total', drafts: [{ path: 'main.py', content: 'value = 3\n' }] }); assert.equal(result.status, 200); assert.equal(result.value.changes.length, 2); assert.equal(result.value.changes.find(item => item.path === 'main.py').before, 'value = 3\n'); assert.ok(!result.value.results.some(item => item.path === '.env'));
  assert.equal(await fs.readFile(path.join(fixture.root, 'workspace/main.py'), 'utf8'), 'value = 1\nprint(value)\n');
  assert.equal((await fixture.call('context', { paths: ['.env'] })).status, 400); assert.equal((await fixture.call('context', { paths: ['../server.mjs'] })).status, 403);
  const context = await fixture.call('context', { paths: ['main.py', 'helper.py'], drafts: [{ path: 'main.py', content: 'unsaved' }] }); assert.equal(context.value.files[0].content, 'unsaved'); assert.equal(context.value.files.length, 2);
});
test('saved code history records both versions and restore is only a preview', async t => {
  const fixture = await createFixture({ files: { 'main.py': 'old\n' } }); t.after(() => fixture.cleanup()); await fixture.start();
  await fixture.call('files', { path: 'main.py', content: 'new\n' }); const history = (await fixture.call('history?path=main.py')).value.versions; assert.equal(history.length, 2);
  const preview = await fixture.call('history/preview', { path: 'main.py', id: history.at(-1).id }); assert.equal(preview.value.changes[0].after, 'old\n'); assert.equal(await fs.readFile(path.join(fixture.root, 'workspace/main.py'), 'utf8'), 'new\n');
  assert.equal((await fixture.call('history/preview', { path: 'main.py', id: '../settings.json' })).status, 400);
});
test('Python/C++ formatting and Python semantic rename return guarded previews', async t => {
  const fixture = await createFixture({ requireLanguages: true, files: { 'main.py': 'def total(values):\n return sum(values)\n\nprint(total([1,2]))\n', 'main.cpp': 'int main(){int x=1;return x;}\n' } }); t.after(() => fixture.cleanup()); await fixture.start();
  const formatted = await fixture.call('editor/preview', { action: 'format', path: 'main.py' }); assert.equal(formatted.status, 200, JSON.stringify(formatted.value)); assert.match(formatted.value.changes[0].after, /    return sum/);
  const renamed = await fixture.call('editor/preview', { action: 'rename', path: 'main.py', position: { line: 0, character: 5 }, newName: 'sum_values' }); assert.equal(renamed.status, 200, JSON.stringify(renamed.value)); assert.ok(renamed.value.changes.some(item => item.after.includes('def sum_values') && item.after.includes('print(sum_values')));
  const cpp = await fixture.call('editor/preview', { action: 'format', path: 'main.cpp' }); assert.equal(cpp.status, 200, JSON.stringify(cpp.value)); assert.match(cpp.value.changes[0].after, /int x = 1/);
});
test('Git panel initializes, stages, commits, lists history and protects sensitive paths', async t => {
  const fixture = await createFixture({ files: { 'main.py': 'print(1)\n', '.env': 'SECRET=x\n' } }); t.after(() => fixture.cleanup()); await fixture.start();
  const initialized = await fixture.call('git', { action: 'init' }); assert.equal(initialized.status, 200, JSON.stringify(initialized.value)); assert.equal(initialized.value.repository, true);
  await fixture.call('git', { action: 'identity', name: 'CodeStudio tests', email: 'tests@example.invalid' });
  assert.equal((await fixture.call('git', { action: 'stage', paths: ['.env'] })).status, 400);
  assert.equal((await fixture.call('git', { action: 'stage', paths: ['main.py'] })).status, 200);
  const committed = await fixture.call('git', { action: 'commit', message: 'Test initial code' }); assert.equal(committed.status, 200, JSON.stringify(committed.value)); assert.equal(committed.value.commits[0].subject, 'Test initial code');
  await fixture.call('files', { path: 'main.py', content: 'print(2)\n' }); const diff = await fixture.call('git/diff', { path: 'main.py' }); assert.match(diff.value.text, /\+print\(2\)/);
});
test('pytest parameterized results, failed-only rerun and branch coverage work without project installation', async t => {
  const fixture = await createFixture({ files: { 'main.py': 'def sign(value):\n    if value >= 0:\n        return 1\n    return -1\n', 'test_main.py': 'import pytest\nfrom main import sign\n@pytest.mark.parametrize("value, expected", [(1,1),(2,1),(3,-1)])\ndef test_sign(value,expected): assert sign(value)==expected\n' } }); t.after(() => fixture.cleanup()); await fixture.start();
  assert.equal((await fixture.call('tests/start', { framework: 'pytest', coverage: true })).status, 200); let state;
  await eventually(async () => { state = (await fixture.call('tests')).value; return state.phase === 'finished'; }, 20000);
  assert.equal(state.cases.length, 3, JSON.stringify(state)); assert.equal(state.passed, false); assert.ok(state.coverage.files['main.py'].missing_lines.includes(4)); assert.ok(state.coverage.totals.missing_branches > 0);
  await fixture.call('tests/start', { framework: 'pytest', failedOnly: true }); await eventually(async () => { state = (await fixture.call('tests')).value; return state.phase === 'finished'; }); assert.equal(state.cases.length, 1); assert.equal(state.cases[0].status, 'failed');
});
test('real PowerShell pseudoterminals accept input, keep separate sessions and close', async t => {
  const fixture = await createFixture(); t.after(() => fixture.cleanup()); await fixture.start();
  const first = await fixture.call('terminals/create', {}); assert.equal(first.status, 200, JSON.stringify(first.value)); const second = await fixture.call('terminals/create', {}); assert.equal(second.status, 200); assert.notEqual(first.value.id, second.value.id);
  await fixture.call('terminals/input', { id: first.value.id, text: 'Write-Output ("TERM" + "_WORKS")\r' });
  await eventually(async () => (await fixture.call('terminals')).value.sessions.find(item => item.id === first.value.id)?.output.includes('TERM_WORKS'), 10000);
  await fixture.call('terminals/close', { id: first.value.id }); await fixture.call('terminals/close', { id: second.value.id }); assert.equal((await fixture.call('terminals')).value.sessions.length, 0);
});
test('templates create offline skeletons and never overwrite an existing project', async t => {
  const fixture = await createFixture(); t.after(() => fixture.cleanup()); await fixture.start();
  const result = await fixture.call('templates', { template: 'python-cli', name: '练习项目' }); assert.equal(result.status, 200); assert.ok(await fs.readFile(path.join(result.value.path, 'test_main.py'), 'utf8')); assert.ok(result.value.task);
  assert.equal((await fixture.call('templates', { template: 'python-cli', name: '练习项目' })).status, 400);
  assert.equal((await fixture.call('templates', { template: 'python-cli', name: '../outside' })).status, 400);
});
test('updates reject a package checksum mismatch and only accept the project release URL', async t => {
  const fixture = await createFixture(); t.after(() => fixture.cleanup());
  const asset = { name: 'CodeStudio-v9.0.0-windows-x64.zip', browser_download_url: 'https://github.com/RoyAdas/CodeStudio/releases/download/v9.0.0/CodeStudio-v9.0.0-windows-x64.zip', digest: 'sha256:' + '0'.repeat(64), size: 3 };
  const updater = createUpdates({ home: fixture.root, version: '0.5.0', dataDir: path.join(fixture.root, 'data'), backups: { capture: async () => {} }, fetcher: async url => url.includes('api.github.com') ? Response.json({ tag_name: 'v9.0.0', assets: [asset] }) : new Response('bad') });
  assert.equal((await updater.check()).newer, true); await assert.rejects(updater.download(), /校验失败/);
  const unsafe = createUpdates({ home: fixture.root, version: '0.5.0', dataDir: path.join(fixture.root, 'data'), backups: {}, fetcher: async () => Response.json({ tag_name: 'v9.0.0', assets: [{ ...asset, browser_download_url: 'https://example.invalid/file' }] }) }); await assert.rejects(unsafe.check(), /可信地址/);
});

test('verified update packages preserve settings and expose both versions for rollback', async t => {
  const fixture = await createFixture(); t.after(() => fixture.cleanup());
  await fs.writeFile(path.join(fixture.root, 'Start.cmd'), '@echo off');
  await fs.writeFile(path.join(fixture.root, 'BUILD.json'), JSON.stringify({ name: 'CodeStudio', version: '0.4.0', platform: 'windows-x64' }));
  const source = path.join(fixture.root, 'update-source'); const app = path.join(source, 'CodeStudio'); const zip = path.join(fixture.root, 'update.zip');
  await fs.mkdir(app, { recursive: true });
  for (const [name, text] of Object.entries({ 'BUILD.json': JSON.stringify({ name: 'CodeStudio', version: '0.5.0', platform: 'windows-x64' }), 'Start.cmd': '@echo off', 'server.mjs': '// fixture' })) await fs.writeFile(path.join(app, name), text);
  await new Promise((resolve, reject) => { const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:STUDIO_TEST_SOURCE,$env:STUDIO_TEST_ZIP)'], { windowsHide: true, env: { ...process.env, STUDIO_TEST_SOURCE: source, STUDIO_TEST_ZIP: zip }, stdio: 'ignore' }); child.once('error', reject); child.once('exit', code => code ? reject(Error('Fixture ZIP creation failed')) : resolve()); });
  const bytes = await fs.readFile(zip); let captured = 0;
  const release = { tag_name: 'v0.5.0', assets: [{ name: 'CodeStudio-v0.5.0-windows-x64.zip', browser_download_url: 'https://github.com/RoyAdas/CodeStudio/releases/download/v0.5.0/CodeStudio-v0.5.0-windows-x64.zip', size: bytes.length, digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex') }] };
  const updater = createUpdates({ home: fixture.root, version: '0.4.0', dataDir: path.join(fixture.root, 'data'), backups: { capture: async () => { captured++; } }, fetcher: async url => url.includes('api.github.com') ? Response.json(release) : new Response(bytes) });
  await updater.check(); const installed = await updater.download(); assert.equal(installed.installed, true); assert.equal(captured, 1);
  const newer = path.join(fixture.root, 'versions/0.5.0'); assert.deepEqual(JSON.parse(await fs.readFile(path.join(newer, 'data/settings.json'), 'utf8')), JSON.parse(await fs.readFile(path.join(fixture.root, 'data/settings.json'), 'utf8')));
  const next = createUpdates({ home: newer, version: '0.5.0', dataDir: path.join(newer, 'data'), backups: {} }); assert.deepEqual((await next.list()).map(item => item.version).sort(), ['0.4.0', '0.5.0']);
  const registered = await next.register({ path: fixture.root }); assert.ok(registered.versions.some(item => item.version === '0.4.0'));
  await assert.rejects(updater.download(), /已存在/);
});

test('coverage warns about unrelated incomplete Python files without losing passing cases', async t => {
  const fixture = await createFixture({ files: { 'main.py': 'def total(): return 3\n', 'draft.py': 'items.\n', 'test_main.py': 'from main import total\ndef test_total(): assert total() == 3\n' } }); t.after(() => fixture.cleanup()); await fixture.start();
  assert.equal((await fixture.call('tests/start', { framework: 'pytest', coverage: true })).status, 200); let result;
  await eventually(async () => { result = (await fixture.call('tests')).value; return result.phase === 'finished'; });
  assert.equal(result.passed, true, JSON.stringify(result)); assert.equal(result.cases[0].status, 'passed'); assert.ok(result.coverage.files['main.py']); assert.equal(result.coverage.files['draft.py'], undefined); assert.match(result.output, /couldnt-parse|Couldn't parse/);
});
