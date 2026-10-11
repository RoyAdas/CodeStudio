import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFixture, eventually } from './helpers.mjs';
import { prepareChanges } from '../ai-changes.mjs';
import { normalizeMentorContext } from '../mentor-shared.mjs';

test('real Python debugger hits a breakpoint, reads variables, steps and excludes concurrent execution', async t => {
  const fixture = await createFixture({ requireLanguages: true, files: { 'main.py': 'total = 1\ntotal += 2\nprint(total)\n' } }); t.after(() => fixture.cleanup()); await fixture.start();
  const started = await fixture.call('debug/start', { path: 'main.py', breakpoints: { 'main.py': [2] }, sourcePaths: ['main.py'] }); assert.equal(started.status, 200, JSON.stringify(started.value));
  await eventually(async () => { const state = (await fixture.call('debug')).value; return state.phase === 'paused' && state.variables.some(item => item.name === 'total' && item.value === '1'); }, 25000);
  let state = (await fixture.call('debug')).value; assert.equal(state.frames[0].path, 'main.py'); assert.equal(state.frames[0].line, 2);
  assert.equal((await fixture.call('run', { path: 'main.py' })).status, 409); assert.equal((await fixture.call('workspace', { path: path.join(fixture.root, 'workspace') })).status, 409);
  assert.equal((await fixture.call('debug/control', { action: 'evaluate' })).status, 400);
  assert.equal((await fixture.call('debug/control', { action: 'next' })).status, 200);
  await eventually(async () => { state = (await fixture.call('debug')).value; return state.phase === 'paused' && state.frames[0]?.line === 3 && state.variables.some(item => item.name === 'total' && item.value === '3'); }, 15000);
  assert.equal((await fixture.call('debug/control', { action: 'continue' })).status, 200);
  await eventually(async () => (await fixture.call('debug')).value.phase === 'finished', 15000);
  assert.match((await fixture.call('debug')).value.output, /3/);
});
test('debugger rejects external files and stops paused sessions', async t => {
  const fixture = await createFixture({ requireLanguages: true, files: { 'main.py': 'value = 8\nprint(value)\n' } }); t.after(() => fixture.cleanup()); await fixture.start();
  assert.equal((await fixture.call('debug/start', { path: '../server.mjs' })).status, 403);
  assert.equal((await fixture.call('debug/start', { path: 'main.py', stopOnEntry: true })).status, 200);
  await eventually(async () => (await fixture.call('debug')).value.phase === 'paused', 20000);
  assert.equal((await fixture.call('debug/control', { action: 'stop' })).status, 200);
  assert.equal((await fixture.call('debug')).value.phase, 'finished');
});
test('unittest panel reports real passes, failures, skips and rejects stale source snapshots', async t => {
  const files = { 'maths.py': 'def total(values):\n    return sum(values)\n', 'test_maths.py': 'import unittest\nfrom maths import total\nclass Totals(unittest.TestCase):\n    def test_normal(self): self.assertEqual(total([1, 2]), 3)\n    def test_empty(self): self.assertEqual(total([]), 0)\n    @unittest.skip("demo")\n    def test_skip(self): pass\n' };
  const fixture = await createFixture({ files }); t.after(() => fixture.cleanup()); await fixture.start();
  assert.equal((await fixture.call('tests/start', {})).status, 200); let state;
  await eventually(async () => { state = (await fixture.call('tests')).value; return state.phase === 'finished'; });
  assert.equal(state.passed, true, JSON.stringify(state)); assert.equal(state.cases.filter(item => item.status === 'passed').length, 2); assert.equal(state.cases.filter(item => item.status === 'skipped').length, 1);
  assert.equal(normalizeMentorContext({ files: [{ path: 'maths.py', code: files['maths.py'] }], tests: state }).tests.matchesCurrentCode, true);
  assert.equal(normalizeMentorContext({ files: [{ path: 'maths.py', code: 'changed' }], tests: state }).tests.matchesCurrentCode, false);
  await fixture.call('files', { path: 'maths.py', content: 'def total(values):\n    return 99\n' });
  assert.equal((await fixture.call('tests/start', {})).status, 200);
  await eventually(async () => { state = (await fixture.call('tests')).value; return state.phase === 'finished'; });
  assert.equal(state.passed, false); assert.ok(state.cases.some(item => item.status === 'failed' && item.detail.includes('AssertionError')));
});
test('empty and interrupted test runs never claim success', async t => {
  const fixture = await createFixture({ files: { 'main.py': 'print(1)\n' } }); t.after(() => fixture.cleanup()); await fixture.start();
  await fixture.call('tests/start', {}); await eventually(async () => (await fixture.call('tests')).value.phase === 'finished'); assert.equal((await fixture.call('tests')).value.passed, false);
  await fixture.call('files', { path: 'test_slow.py', content: 'import unittest,time\nclass Slow(unittest.TestCase):\n    def test_slow(self): time.sleep(30)\n' });
  await fixture.call('tests/start', {}); assert.equal((await fixture.call('run', { path: 'main.py' })).status, 409); await fixture.call('tests/stop', {});
  await eventually(async () => (await fixture.call('tests')).value.phase === 'finished'); assert.equal((await fixture.call('tests')).value.passed, false); assert.equal((await fixture.call('tests')).value.stopped, true);
});
test('AI change proposals preserve the draft baseline, allow new tests and cannot edit unrelated or sensitive files', async t => {
  const fixture = await createFixture({ files: { 'main.py': 'old disk\n', 'other.py': 'private unrelated\n' } }); t.after(() => fixture.cleanup());
  const safePath = async (relative, allowNew) => { if (relative.includes('..') || path.isAbsolute(relative)) throw Error('outside'); const file = path.join(fixture.root, 'workspace', relative); if (!allowNew) await fs.access(file); return file; };
  const input = { instruction: 'Fix totals', files: [{ path: 'main.py', content: 'unsaved draft\n' }] };
  const askAI = async () => ({ text: JSON.stringify({ summary: 'Fix', files: [{ path: 'main.py', content: 'fixed\n' }, { path: 'test_total.py', content: 'import unittest\n' }] }) });
  const result = await prepareChanges(input, { safePath, askAI }); assert.equal(result.changes[0].before, 'unsaved draft\n'); assert.equal(result.changes[1].before, null); assert.equal(await fs.readFile(path.join(fixture.root, 'workspace/main.py'), 'utf8'), 'old disk\n');
  for (const target of ['other.py', '.env', '../escape.py']) await assert.rejects(prepareChanges(input, { safePath, askAI: async () => ({ text: JSON.stringify({ files: [{ path: target, content: 'oops' }] }) }) }));
  await assert.rejects(prepareChanges({ ...input, kind: 'tests' }, { safePath, askAI }));
});
