import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMentorController } from '../mentor.mjs';
import { textFingerprint, normalizeMentorContext, contextFingerprint, isSensitiveMentorPath } from '../mentor-shared.mjs';

const code = 'def total(items):\n    return sum(items)\n';
const context = { activePath: 'main.py', language: 'python', files: [{ path: 'main.py', code }] };
const plan = { title: 'Practice totals', overview: 'Write, run, explain.', steps: [
  { title: 'Sum values', goal: 'Return the sum.', hint: 'Think about accumulation.', acceptance: 'The total is correct.' },
  { title: 'Empty values', goal: 'Handle no values.', hint: 'What is the identity?', acceptance: 'An empty list returns zero.' },
] };
const review = { status: 'passed', note: 'The visible code meets the current goal.', hint: 'Confirm to continue.', evidence: [] };

async function controllerFixture(t, askOverride) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-studio-mentor-unit-'));
  let workspace = path.join(dataDir, 'workspace-a');
  const calls = [];
  const responses = [];
  const dependencies = { dataDir, getWorkspace: () => workspace, broadcast() {}, askAI: async input => {
    calls.push(input);
    if (askOverride) return askOverride(input, calls.length);
    const response = responses.shift() ?? (calls.length === 1 ? plan : review);
    if (response instanceof Error) throw response;
    return { text: typeof response === 'string' ? response : JSON.stringify(response) };
  } };
  const controller = createMentorController(dependencies);
  t.after(async () => { controller.abortAll(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const start = () => controller.handle('start', { task: 'Teach me to sum values.', context });
  return { controller, start, responses, calls, dependencies, changeWorkspace(name) { workspace = path.join(dataDir, name); } };
}

test('fingerprints distinguish equal-length edits and remain stable after normalization', () => {
  assert.notEqual(textFingerprint('abc'), textFingerprint('abd'));
  assert.equal(contextFingerprint(context), contextFingerprint(normalizeMentorContext(context)));
  const twoFiles = { ...context, files: [{ path: 'b.py', code: 'b=2' }, ...context.files] };
  assert.equal(contextFingerprint(twoFiles), contextFingerprint({ ...twoFiles, files: [...twoFiles.files].reverse() }));
});

test('learner-selected hint depth is persisted; automatic checks always use light hints', async t => {
  const fixture = await controllerFixture(t); await fixture.start();
  for (const [level, phrase] of [['hint', '轻提示'], ['approach', '详细思路'], ['example', '短代码示例']]) {
    const result = await fixture.controller.handle('check', { trigger: 'manual', hintLevel: level, context });
    assert.equal(result.session.review.hintLevel, level); assert.ok(fixture.calls.at(-1).system.includes(phrase));
  }
  const changed = { ...context, files: [{ path: 'main.py', code: code + '# changed\n' }] };
  const result = await fixture.controller.handle('check', { trigger: 'run', hintLevel: 'example', context: changed });
  // The automatic cooldown may skip the check; advance time through the stored
  // session only for this fixture to exercise the actual automatic prompt.
  if (result.skipped) { result.session.lastCheckAt = 0; await fixture.controller.handle('check', { trigger: 'run', hintLevel: 'example', context: changed }); }
  assert.ok(fixture.calls.at(-1).system.includes('本次只给一条轻提示'));
  assert.ok(!fixture.calls.at(-1).system.includes('学习者明确请求示例'));
});

test('long file excerpts preserve full-source identity and reject old run evidence', () => {
  const original = 'x=1\n' + '# context\n'.repeat(2200);
  const snapshot = { activePath: 'large.py', files: [{ path: 'large.py', code: original }], run: { id: 'run-1', path: 'large.py', phase: 'finished', code: 0, sourceFingerprint: textFingerprint(original), output: 'ok' } };
  const normalized = normalizeMentorContext(snapshot);
  assert.equal(normalized.files[0].code.length, 18000);
  assert.equal(normalized.files[0].truncated, true);
  assert.equal(normalized.run.matchesCurrentCode, true);
  const changed = { ...snapshot, files: [{ path: 'large.py', code: original + 'x=2\n' }] };
  assert.notEqual(contextFingerprint(snapshot), contextFingerprint(changed));
  assert.equal(normalizeMentorContext(changed).run.matchesCurrentCode, false);
  assert.equal(contextFingerprint(snapshot), contextFingerprint(normalized));
});

test('snapshot limits preserve the active file, deduplicate files and cap context', () => {
  const files = Array.from({ length: 9 }, (_, index) => ({ path: `${index}.py`, code: `${index}`.repeat(9000) }));
  const normalized = normalizeMentorContext({ activePath: '8.py', files: [...files, files[8]], selection: 's'.repeat(3000), run: { output: 'o'.repeat(12000) } });
  assert.ok(normalized.files.some(file => file.path === '8.py'));
  assert.ok(normalized.files.length <= 6);
  assert.ok(normalized.files.reduce((sum, file) => sum + file.code.length, 0) <= 36000);
  assert.equal(new Set(normalized.files.map(file => file.path)).size, normalized.files.length);
  assert.equal(normalized.selection.length, 2000);
  assert.equal(normalized.run.output.length, 10000);
});

test('sensitive filenames are excluded together with their active selection and run output', () => {
  for (const name of ['.env', 'project/.env.local', 'cert.PEM', 'api.key', 'secrets.json', 'credentials', '.aws/config', '.git/config', '.ssh/id_rsa', 'data/settings.json', 'nested\\.ENV.production']) {
    assert.equal(isSensitiveMentorPath(name), true, name);
  }
  assert.equal(isSensitiveMentorPath('src/main.py'), false);
  const sensitive = { activePath: '.env', language: 'plaintext',
    files: [{ path: '.env', code: 'SECRET_TOKEN=do-not-send' }, { path: 'main.py', code }],
    selection: 'selected-secret-do-not-send', run: { path: '.env', output: 'logged-secret-do-not-send', code: 0 },
  };
  const normalized = normalizeMentorContext(sensitive);
  assert.equal(normalized.activePath, '');
  assert.equal(normalized.selection, '');
  assert.equal(normalized.run, null);
  assert.deepEqual(normalized.files.map(file => file.path), ['main.py']);
  assert.equal(JSON.stringify(normalized).includes('do-not-send'), false);
});

test('plans persist and restores keep separate workspace progress', async t => {
  const fixture = await controllerFixture(t);
  const { session } = await fixture.start();
  assert.equal(session.steps.length, 2);
  assert.equal(session.status, 'active');
  assert.equal(fixture.calls.length, 1);
  const restored = createMentorController(fixture.dependencies);
  assert.equal((await restored.handle('state')).session.id, session.id);
  fixture.changeWorkspace('workspace-b');
  assert.equal((await restored.handle('state')).session, null);
  fixture.changeWorkspace('workspace-a');
  assert.equal((await restored.handle('state')).session.currentStep, 0);
});

test('review evidence excludes unknown files and out-of-range line references', async t => {
  const fixture = await controllerFixture(t);
  await fixture.start();
  fixture.responses.push({ ...review, evidence: [
    { path: '../outside.py', line: 1, message: 'Unknown file' },
    { path: 'main.py', line: 2, message: 'Valid line' },
    { path: 'main.py', line: 99, message: 'Outside excerpt' },
  ] });
  const { session } = await fixture.controller.handle('check', { trigger: 'manual', context });
  assert.deepEqual(session.review.evidence, [{ path: 'main.py', line: 2, message: 'Valid line' }]);
  assert.equal(session.review.runEvidence, false);
});

test('pause and manual mode suppress automatic requests but allow explicit checks', async t => {
  const fixture = await controllerFixture(t);
  await fixture.start();
  await fixture.controller.handle('pause');
  assert.equal((await fixture.controller.handle('check', { trigger: 'idle', context })).reason, 'inactive');
  assert.equal(fixture.calls.length, 1);
  await fixture.controller.handle('options', { autoMode: 'manual', minInterval: 60000 });
  await fixture.controller.handle('resume');
  assert.equal((await fixture.controller.handle('check', { trigger: 'run', context })).reason, 'disabled');
  await fixture.controller.handle('check', { trigger: 'manual', context });
  assert.equal(fixture.calls.length, 2);
});

test('automatic checks skip duplicate code and enforce the request interval', async t => {
  const fixture = await controllerFixture(t);
  await fixture.start();
  await fixture.controller.handle('check', { trigger: 'idle', context });
  assert.equal((await fixture.controller.handle('check', { trigger: 'run', context })).reason, 'unchanged');
  const changed = { ...context, files: [{ path: 'main.py', code: code + '# changed\n' }] };
  const result = await fixture.controller.handle('check', { trigger: 'idle', context: changed });
  assert.equal(result.reason, 'cooldown');
  assert.ok(result.retryAfterMs > 0 && result.retryAfterMs <= 20000);
  assert.equal(fixture.calls.length, 2);
  assert.equal(result.session.autoChecks, 1);
});

test('only a current passed review can advance and complete a task', async t => {
  const fixture = await controllerFixture(t);
  await fixture.start();
  await assert.rejects(fixture.controller.handle('advance', { context }), /检查当前步骤/);
  await fixture.controller.handle('check', { trigger: 'manual', context });
  await assert.rejects(fixture.controller.handle('advance', { context: { ...context, files: [{ path: 'main.py', code: code + '# edit\n' }] } }), { status: 409 });
  const advanced = await fixture.controller.handle('advance', { context });
  assert.equal(advanced.session.currentStep, 1);
  assert.equal(advanced.session.steps[0].completed, true);
  assert.equal(advanced.session.review, null);
  await fixture.controller.handle('check', { trigger: 'manual', context });
  const completed = await fixture.controller.handle('advance', { context });
  assert.equal(completed.session.status, 'completed');
  assert.ok(completed.session.steps.every(step => step.completed));
  assert.equal((await fixture.controller.handle('check', { trigger: 'idle', context })).reason, 'inactive');
});

test('invalid model output pauses checks without inventing feedback and reset removes state', async t => {
  const fixture = await controllerFixture(t);
  await fixture.start();
  fixture.responses.push('not valid JSON');
  await assert.rejects(fixture.controller.handle('check', { trigger: 'manual', context }), { status: 502 });
  const state = await fixture.controller.handle('state');
  assert.equal(state.session.status, 'paused');
  assert.equal(state.session.review, null);
  assert.match(state.session.lastError, /有效的任务结构/);
  assert.equal((await fixture.controller.handle('check', { trigger: 'idle', context })).reason, 'inactive');
  await fixture.controller.handle('reset');
  const restored = createMentorController(fixture.dependencies);
  assert.equal((await restored.handle('state')).session, null);
});

test('pausing cancels an in-flight check and discards late feedback', async t => {
  let release;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const fixture = await controllerFixture(t, async (input, count) => {
    if (count === 1) return { text: JSON.stringify(plan) };
    started(input.signal);
    await held;
    return { text: JSON.stringify(review) };
  });
  t.after(() => release());
  await fixture.start();
  const pending = fixture.controller.handle('check', { trigger: 'manual', context });
  const signal = await waiting;
  assert.equal((await fixture.controller.handle('state')).phase, 'checking');
  await fixture.controller.handle('pause');
  assert.equal(signal.aborted, true);
  release();
  assert.equal((await pending).canceled, true);
  assert.equal((await fixture.controller.handle('state')).session.review, null);
  assert.equal((await fixture.controller.handle('state')).phase, 'idle');
});

test('the hourly automatic-check limit pauses before another API call and permits explicit checks', async t => {
  const fixture = await controllerFixture(t);
  await fixture.start();
  await fixture.controller.handle('options', { maxAutoChecksPerHour: 10 });
  const storage = path.join(fixture.dependencies.dataDir, 'mentor-sessions.json');
  const stored = JSON.parse(await fs.readFile(storage, 'utf8'));
  const session = Object.values(stored.sessions)[0];
  session.automaticRequests = [...Array(10).fill(Date.now() - 1000), Date.now() - 3600001];
  await fs.writeFile(storage, JSON.stringify(stored));
  const restored = createMentorController(fixture.dependencies);
  const limited = await restored.handle('check', { trigger: 'idle', context });
  assert.equal(limited.reason, 'hourly-limit');
  assert.equal(limited.session.status, 'paused');
  assert.equal(limited.session.automaticRequests.length, 10);
  assert.equal(fixture.calls.length, 1);
  await restored.handle('check', { trigger: 'manual', context });
  assert.equal(fixture.calls.length, 2);
  assert.equal((await restored.handle('state')).session.metrics.requests, 2);
});

test('a disabled hourly limit allows automatic checks and ignores unsupported limit values', async t => {
  const fixture = await controllerFixture(t);
  await fixture.start();
  assert.equal((await fixture.controller.handle('options', { maxAutoChecksPerHour: 11 })).session.options.maxAutoChecksPerHour, 30);
  assert.equal((await fixture.controller.handle('options', { maxAutoChecksPerHour: 0 })).session.options.maxAutoChecksPerHour, 0);
  const result = await fixture.controller.handle('check', { trigger: 'idle', context });
  assert.equal(result.skipped, undefined);
  assert.equal(result.session.autoChecks, 1);
});

test('request metrics count calls and only accumulate usage actually returned by the provider', async t => {
  const fixture = await controllerFixture(t, async (input, count) => ({
    text: JSON.stringify(count === 1 ? plan : review),
    ...(count === 1 ? { usage: { prompt_tokens: 100, completion_tokens: 25 } }
      : count === 2 ? { usage: { input_tokens: 30, output_tokens: 10 } } : {}),
  }));
  await fixture.start();
  await fixture.controller.handle('check', { trigger: 'manual', context });
  await fixture.controller.handle('check', { trigger: 'question', context, question: 'Why sum?' });
  const state = await fixture.controller.handle('state');
  assert.deepEqual(state.session.metrics, { requests: 3, reportedTokens: 165, usageResponses: 2 });
});
