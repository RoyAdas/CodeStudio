import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { textFingerprint, normalizeMentorContext, contextFingerprint } from '../mentor-shared.mjs';
import { createFixture, listen, closeServer, sleep, eventually, projectRoot } from './helpers.mjs';

// All project files, settings, keys and API responses below are disposable test
// fixtures. No existing app, workspace or external AI service is contacted.
const samples = {
  'main.py': 'def calculate_total(amounts):\n    # TODO: implement sum\n    return 0\n\nprint(calculate_total([1, 2, 3]))\n',
  'hello.c': '#include <stdio.h>\nint main(void) { printf("C OK\\n"); return 0; }\n',
  'hello.cpp': '#include <iostream>\nint main() { std::cout << "C++ OK" << std::endl; return 0; }\n',
};
const records = [];
let authFailure = false;
let malformed = false;
let hold = false;
const mock = http.createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const input = JSON.parse(raw);
    const system = input.system || input.instructions || input.messages?.find(message => message.role === 'system')?.content || '';
    const user = input.messages?.find(message => message.role === 'user')?.content || input.input?.at(-1)?.content || '';
    const isPlan = system.includes('把任务拆成');
    const isCheck = system.includes('只检查当前步骤');
    const record = { kind: isPlan ? 'plan' : isCheck ? 'check' : 'other', input, url: req.url, time: Date.now() };
    records.push(record);
    if (hold && isCheck) { hold = false; await sleep(1700); }
    if (authFailure && isCheck) {
      authFailure = false;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"test auth denied"}}');
      return;
    }
    let text;
    if (malformed) { malformed = false; text = 'format intentionally invalid'; }
    else if (isPlan) text = JSON.stringify({ title: '完成 Python 账单求和', overview: '先求和，再处理空输入，最后验证。', steps: [
      { title: '实现求和函数', goal: '实现 calculate_total，让 [1,2,3] 的总额为 6。', hint: '先建一个 total，再把每笔金额加进去。', acceptance: '运行当前代码，输出 6。' },
      { title: '处理空列表', goal: '为 [] 返回 0，并加入验证。', hint: '看看 sum 的空列表结果。', acceptance: '用 assert 验证空列表得到 0。' },
      { title: '整理说明', goal: '为函数补充简洁文档。', hint: '说明输入和返回值。', acceptance: '函数包含清楚的 docstring。' },
    ] });
    else if (isCheck) {
      const snapshot = JSON.parse(user.slice(user.lastIndexOf('当前快照：') + '当前快照：'.length));
      record.snapshot = snapshot;
      const code = snapshot.files.find(file => file.path === 'main.py')?.code || '';
      const passed = code.includes('sum(amounts)') && snapshot.run?.matchesCurrentCode && snapshot.run.phase === 'finished' && snapshot.run.code === 0 && snapshot.run.output.includes('6');
      text = JSON.stringify({ status: passed ? 'passed' : code.includes('sum(amounts)') ? 'in_progress' : 'needs_fix',
        note: passed ? '当前版本实际运行输出 6，这一步通过。' : code.includes('sum(amounts)') ? '静态代码已实现求和，请运行当前版本验证。' : '返回值仍为 0，需要累加金额。',
        hint: passed ? '你可以确认完成，再进入下一步。' : '尝试让返回值来自金额列表，再运行看结果。',
        evidence: [{ path: 'main.py', line: 3, message: '查看这里的返回值。' }, { path: '../outside.py', line: 1, message: '无效引用应被过滤' }],
      });
    } else text = system.startsWith('You complete') ? '# completion\n' : '兼容接口正常';
    const response = req.url.endsWith('/responses') ? { output: [{ content: [{ type: 'output_text', text }] }] }
      : req.url.endsWith('/messages') ? { content: [{ type: 'text', text }] }
        : { choices: [{ message: { content: text } }] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});

const resultDir = path.join(projectRoot, 'test-results');
const checks = [];
const skipped = [];
const errors = [];
const external = [];
let fixture;
let browser;
let page;
const checkCount = () => records.filter(record => record.kind === 'check').length;

async function toolFromPath(names) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), name);
      try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch {}
    }
  }
  return '';
}

async function call(route, data) {
  return page.evaluate(async ({ route, data }) => {
    const token = document.querySelector('meta[name="studio-token"]').content;
    const response = await fetch(`/api/${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-Studio-Token': token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, value: await response.json() };
  }, { route, data });
}
async function edit(code) {
  await page.getByRole('textbox', { name: '代码编辑器', exact: true }).focus();
  await page.keyboard.press('Control+A');
  await page.evaluate(value => navigator.clipboard.writeText(value), code);
  await page.keyboard.press('Control+V');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function getMentor() { return (await call('mentor')).value.session; }

try {
  await fs.mkdir(resultDir, { recursive: true });
  const mockBase = await listen(mock);
  const tools = {};
  if (process.env.STUDIO_TEST_PYTHON) tools.python = process.env.STUDIO_TEST_PYTHON;
  else if (process.platform !== 'win32') tools.python = await toolFromPath(['python3', 'python']);
  if (process.env.STUDIO_TEST_CC) tools.c = process.env.STUDIO_TEST_CC;
  else if (process.platform !== 'win32') tools.c = await toolFromPath(['gcc', 'clang']);
  if (process.env.STUDIO_TEST_CXX) tools.cpp = process.env.STUDIO_TEST_CXX;
  else if (process.platform !== 'win32') tools.cpp = await toolFromPath(['g++', 'clang++']);
  fixture = await createFixture({ files: samples, requireDist: true, settings: { baseUrl: `${mockBase}/v1`, model: 'mentor-mock', tools } });
  const base = await fixture.start();
  const initialState = (await fixture.call('state')).value;
  assert.equal(initialState.tools.python.available, true, 'Python is required for this end-to-end test. Install Python or set STUDIO_TEST_PYTHON to its executable.');
  browser = await chromium.launch({ headless: true, ...(process.env.STUDIO_BROWSER_EXECUTABLE ? { executablePath: process.env.STUDIO_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1536, height: 960 } });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', event => { if (event.type() === 'error' && !/Failed to load resource:.*status of (409|502)/.test(event.text())) errors.push(event.text()); });
  page.on('request', request => { if (!request.url().startsWith(`${base}/`) && !request.url().startsWith('blob:') && !request.url().startsWith('data:')) external.push(request.url()); });

  const longSource = 'x = 1\n' + '# context\n'.repeat(2200);
  const snapshot = { activePath: 'large.py', files: [{ path: 'large.py', code: longSource }], run: { id: 'large-run', path: 'large.py', phase: 'finished', code: 0, sourceFingerprint: textFingerprint(longSource), output: 'ok' } };
  const normalizedLong = normalizeMentorContext(snapshot);
  assert.equal(normalizedLong.files[0].truncated, true);
  assert.equal(normalizedLong.run.matchesCurrentCode, true);
  const changedLong = { ...snapshot, files: [{ path: 'large.py', code: longSource + 'x = 2\n' }] };
  assert.notEqual(contextFingerprint(snapshot), contextFingerprint(changedLong));
  assert.equal(normalizeMentorContext(changedLong).run.matchesCurrentCode, false);
  assert.equal(contextFingerprint(normalizedLong), contextFingerprint(snapshot));
  checks.push('Edits beyond excerpts invalidate old feedback and run evidence');

  await page.goto(base);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await page.getByRole('textbox', { name: '导师任务' }).fill('带我完成 Python 账单求和，一步一步让我自己写。');
  await page.getByRole('button', { name: '提交任务，开始指导' }).click();
  await page.locator('.mentor-step.current').waitFor();
  assert.equal((await getMentor()).steps.length, 3);
  assert.ok(records[0].input.messages.at(-1).content.includes('TODO'));
  assert.equal(checkCount(), 0);
  checks.push('Task planning receives initial code and does not immediately trigger a check');

  const edited = samples['main.py'].replace('# TODO: implement sum', '# edited once: implement sum');
  await edit(edited);
  await page.locator('.mentor-review.needs-fix').waitFor({ timeout: 15000 });
  assert.equal(checkCount(), 1);
  assert.ok(records.at(-1).snapshot.files[0].code.includes('edited once'));
  assert.equal(await fs.readFile(path.join(fixture.root, 'workspace/main.py'), 'utf8'), samples['main.py']);
  assert.equal((await getMentor()).review.evidence.length, 1);
  await page.locator('.mentor-inline-hint').first().waitFor();
  checks.push('Idle checks review unsaved edits, add inline hints and filter invalid references');

  await page.locator('.mentor-evidence button').click();
  await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('行 3，列 1'));
  checks.push('Evidence links navigate to the corresponding editor line');

  const fixed = samples['main.py'].replace('return 0', 'return sum(amounts)');
  await edit(fixed + '# rapid edit 1\n');
  await edit(fixed + '# rapid edit 2\n');
  await edit(fixed);
  await page.locator('.run-button').click();
  await page.waitForFunction(() => document.querySelector('.run-state')?.textContent?.includes('退出码 0'));
  await sleep(5500);
  assert.equal(checkCount(), 1);
  checks.push('Rapid edits and runs are coalesced within the minimum request interval');

  await page.locator('.mentor-review.passed').waitFor({ timeout: 26000 });
  assert.equal(checkCount(), 2);
  const passed = await getMentor();
  assert.equal(passed.review.trigger, 'run');
  assert.equal(records.at(-1).snapshot.run.matchesCurrentCode, true);
  assert.ok(records.at(-1).snapshot.run.output.includes('6'));
  checks.push('Run-triggered checks receive output for the current source version');
  await page.screenshot({ path: path.join(resultDir, 'realtime-mentor.png') });

  await edit(fixed + '# unsaved after approval\n');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find(button => button.textContent.includes('进入下一步'))?.disabled);
  assert.ok(await page.getByRole('button', { name: '进入下一步' }).isDisabled());
  const state = (await call('state')).value;
  const changed = { activePath: 'main.py', language: 'python', files: [{ path: 'main.py', code: fixed + '# unsaved after approval\n' }], run: state.run };
  assert.equal((await call('mentor/advance', { sessionId: passed.id, context: changed })).status, 409);
  checks.push('Code changes invalidate a passed review and prevent advancing');

  await page.getByRole('textbox', { name: '代码编辑器', exact: true }).focus();
  await page.keyboard.press('Control+Z');
  await page.getByRole('button', { name: '进入下一步' }).click();
  await page.waitForFunction(() => document.querySelector('.mentor-eyebrow')?.textContent?.includes('2 / 3'));
  await page.reload();
  await page.locator('.monaco-editor .view-lines').waitFor();
  assert.equal((await getMentor()).currentStep, 1);
  assert.equal((await getMentor()).steps[0].completed, true);
  checks.push('Completed steps and task progress restore after reload');

  await page.getByRole('button', { name: '暂停导师' }).click();
  await page.getByRole('button', { name: '恢复导师' }).waitFor();
  const beforePause = checkCount();
  await edit(fixed + '# paused edit\n');
  await sleep(5700);
  assert.equal(checkCount(), beforePause);
  checks.push('Pausing prevents automatic API calls during edits');

  await page.getByLabel('导师自动检查').selectOption('manual');
  await page.getByRole('button', { name: '恢复导师' }).click();
  await page.getByRole('button', { name: '暂停导师' }).waitFor();
  authFailure = true;
  await page.getByRole('button', { name: '检查这一步', exact: true }).click();
  await page.locator('.mentor-error').waitFor();
  assert.equal((await getMentor()).status, 'paused');
  const failedCount = checkCount();
  await edit(fixed + '# error recovery\n');
  await sleep(5200);
  assert.equal(checkCount(), failedCount);
  checks.push('API failures preserve the task and pause background retries');

  await page.getByRole('button', { name: '恢复导师' }).click();
  await page.getByRole('button', { name: '暂停导师' }).waitFor();
  const previousReview = (await getMentor()).review;
  hold = true;
  const beforeHold = checkCount();
  await page.getByRole('button', { name: '检查这一步', exact: true }).click();
  await eventually(() => checkCount() > beforeHold);
  await edit(fixed + '# changed during model request\n');
  await sleep(2100);
  assert.deepEqual((await getMentor()).review, previousReview);
  assert.equal((await call('mentor')).value.phase, 'idle');
  checks.push('Edits cancel in-flight reviews so obsolete feedback is not committed');

  malformed = true;
  await page.getByRole('button', { name: '检查这一步', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.mentor-error')?.textContent?.includes('有效的任务结构'));
  assert.equal((await getMentor()).status, 'paused');
  checks.push('Invalid model JSON yields a recoverable error without invented feedback');

  for (const protocol of ['responses', 'anthropic', 'chat']) {
    await call('settings', { protocol });
    const response = await call('ai', { kind: 'chat', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(response.status, 200);
  }
  checks.push('All three AI protocol adapters continue to work');

  const otherRoot = path.join(fixture.root, 'workspace-other');
  await fs.mkdir(otherRoot);
  await fs.writeFile(path.join(otherRoot, 'other.py'), 'print("other")\n');
  await call('workspace', { path: otherRoot });
  assert.equal(await getMentor(), null);
  await call('workspace', { path: path.join(fixture.root, 'workspace') });
  assert.equal((await getMentor()).currentStep, 1);
  checks.push('Independent workspaces retain separate mentor tasks');

  await call('mentor/reset', {});
  assert.equal(await getMentor(), null);
  checks.push('Ending a task removes persisted progress');

  await page.reload();
  await page.locator('.monaco-editor .view-lines').waitFor();
  for (const [file, expected, tool] of [['hello.c', 'C OK', 'c'], ['hello.cpp', 'C++ OK', 'cpp']]) {
    if (!initialState.tools[tool].available) {
      skipped.push(`${file}: compiler unavailable; install the compiler or set ${tool === 'c' ? 'STUDIO_TEST_CC' : 'STUDIO_TEST_CXX'}.`);
      continue;
    }
    await page.locator(`.tree-row[title="${file}"]`).click();
    await page.locator('.run-button').click();
    await page.waitForFunction(text => document.querySelector('.terminal-output')?.textContent?.includes(text), expected);
    await page.waitForFunction(() => document.querySelector('.run-state')?.textContent?.includes('退出码 0'));
  }
  checks.push('Available C/C++ compilers still build and execute source-version-tracked programs');

  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  assert.equal(fixture.log, '');
  checks.push('UI assets stay local with no browser or service errors');
  const report = { passed: checks.length, checks, skipped };
  await fs.writeFile(path.join(resultDir, 'realtime-mentor-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(resultDir, 'realtime-mentor-failure.png') }).catch(() => {});
  console.error(JSON.stringify({ completed: checks, skipped, errors, serviceLog: fixture?.log || '', records: records.map(record => ({ kind: record.kind, matchesCurrentCode: record.snapshot?.run?.matchesCurrentCode })) }, null, 2));
  throw error;
} finally {
  if (browser) await browser.close();
  if (fixture) await fixture.cleanup();
  await closeServer(mock);
}
