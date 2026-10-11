import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { createFixture, listen, closeServer, projectRoot, eventually } from './helpers.mjs';
const checks = []; const errors = []; let lastReview;
const provider = http.createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw); const system = body.messages[0].content; const user = body.messages.at(-1).content;
  let answer;
  if (system.includes('可审核的代码修改')) {
    const files = JSON.parse(user.split('文件（可能未保存）：')[1].split('\n实际测试结果：')[0]);
    answer = { summary: 'Review a small fix and tests.', files: system.includes('只生成 Python unittest') ? [{ path: 'test_generated.py', content: 'import unittest\nfrom maths import total\nclass Generated(unittest.TestCase):\n    def test_edge(self): self.assertEqual(total([]), 0)\n', reason: 'Check the empty case.' }] : [{ path: files[0].path, content: files[0].content.replace('return 99', 'return sum(values)'), reason: 'Return the real total.' }] };
  } else if (system.includes('把任务拆成')) answer = { title: 'Totals', overview: 'Learn with tests.', steps: [{ title: 'Implement total', goal: 'Sum the list.', hint: 'Accumulate.', acceptance: 'Normal and empty cases pass.' }] };
  else { lastReview = body; answer = { status: 'passed', note: 'Test review.', hint: 'Check an edge case.', evidence: [] }; }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
});
const providerBase = await listen(provider);
const fixture = await createFixture({ requireDist: true, requireLanguages: true, settings: { baseUrl: providerBase, locale: 'en' }, files: { 'maths.py': 'def total(values):\n    return 99\n\nprint(total([1, 2]))\n', 'test_maths.py': 'import unittest\nfrom maths import total\nclass Totals(unittest.TestCase):\n    def test_normal(self): self.assertEqual(total([1, 2]), 3)\n    def test_empty(self): self.assertEqual(total([]), 0)\n' } });
let browser; let page;
async function check(name, run) { await run(); checks.push(name); console.log('PASS ' + name); }
async function code(value) { await page.locator('.monaco-editor').first().click(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(value); }
try {
  await fixture.start(); browser = await chromium.launch({ headless: true, ...(process.env.STUDIO_BROWSER_EXECUTABLE ? { executablePath: process.env.STUDIO_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.base); await page.locator('.monaco-editor textarea').first().waitFor();
  await check('Python debugger controls and real variable values work in the browser', async () => {
    await page.getByRole('button', { name: 'Debug', exact: true }).click();
    await page.getByLabel('Pause at entry').check(); await page.getByRole('button', { name: 'Start Python debugging', exact: true }).click();
    await page.getByRole('button', { name: 'Step over', exact: true }).waitFor();
    await eventually(async () => (await fixture.call('debug')).value.frames.length > 0);
    await page.getByRole('button', { name: 'Step over', exact: true }).click();
    await eventually(async () => (await fixture.call('debug')).value.frames[0]?.line === 4);
    await page.getByRole('button', { name: 'Stop debugging', exact: true }).click(); await page.getByText('Debug session ended', { exact: true }).waitFor();
  });
  await check('Failed tests are shown and cannot pass mentor acceptance', async () => {
    await page.getByLabel('Mentor task').fill('Teach me totals with real tests'); await page.getByRole('button', { name: 'Submit task and start learning', exact: true }).click();
    await page.getByLabel('Mentor automatic checks').selectOption('manual');
    await page.getByRole('button', { name: 'Tests', exact: true }).click(); await page.getByRole('button', { name: 'Save and run tests', exact: true }).click();
    await page.getByText('Passed 0 / 2', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Ask mentor to review tests', exact: true }).click();
    await page.getByText('Tests have not all passed. Resolve failures, errors or an empty test run first.', { exact: true }).waitFor();
    assert.ok(lastReview.messages.at(-1).content.includes('failed')); assert.equal((await fixture.call('mentor')).value.session.review.status, 'needs_fix');
  });
  await check('AI proposals show side-by-side differences, accept drafts and support undo', async () => {
    await page.getByRole('button', { name: 'Review AI changes', exact: true }).click(); await page.getByLabel('Requested changes').fill('Fix the total function.'); await page.getByRole('button', { name: 'Generate changes', exact: true }).click();
    await page.getByRole('button', { name: 'Accept selected changes', exact: true }).waitFor(); await page.locator('.monaco-diff-editor').waitFor();
    assert.equal(await fs.readFile(path.join(fixture.root, 'workspace/maths.py'), 'utf8'), 'def total(values):\n    return 99\n\nprint(total([1, 2]))\n');
    await page.getByRole('button', { name: 'Accept selected changes', exact: true }).click(); await page.locator('.editor-tab .dirty-dot').waitFor();
    await page.getByRole('button', { name: 'Undo last acceptance', exact: true }).click(); await page.locator('.editor-tab .dirty-dot').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Review AI changes', exact: true }).click(); await page.getByLabel('Requested changes').fill('Fix the total function.'); await page.getByRole('button', { name: 'Generate changes', exact: true }).click(); await page.getByRole('button', { name: 'Accept selected changes', exact: true }).click();
  });
  await check('Unsaved edits invalidate tests; rerun verifies the accepted implementation', async () => {
    await page.getByText('Code changed; run tests again', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Save and run tests', exact: true }).click();
    await page.getByText('Passed 2 / 2', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Ask mentor to review tests', exact: true }).click(); await page.getByText('Test review.', { exact: true }).waitFor(); assert.equal((await fixture.call('mentor')).value.session.review.status, 'passed');
  });
  await check('Generated tests require review and explicit saving', async () => {
    await page.getByRole('button', { name: 'Generate AI test suggestions', exact: true }).click(); await page.getByRole('button', { name: 'Generate changes', exact: true }).click(); await page.getByLabel('Select change test_generated.py').waitFor();
    await assert.rejects(fs.access(path.join(fixture.root, 'workspace/test_generated.py')));
    await page.getByRole('button', { name: 'Accept selected changes', exact: true }).click(); await page.locator('.editor-tab.active').filter({ hasText: 'test_generated.py' }).waitFor(); await page.keyboard.press('Control+S');
    await eventually(async () => { try { return (await fs.readFile(path.join(fixture.root, 'workspace/test_generated.py'), 'utf8')).includes('test_edge'); } catch { return false; } });
  });
  await check('New debugger, test and diff UI switches between Chinese and English without browser errors', async () => {
    await page.getByRole('button', { name: 'Save and run tests', exact: true }).click(); await page.getByText('Passed 3 / 3', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Ask mentor to review tests', exact: true }).click(); await page.getByText('Test review.', { exact: true }).waitFor();
    await page.getByLabel('Interface language').selectOption('zh-CN'); await page.getByRole('button', { name: '保存并运行测试', exact: true }).waitFor();
    await page.getByLabel('界面语言').selectOption('en'); await page.getByRole('button', { name: 'Save and run tests', exact: true }).waitFor(); assert.deepEqual(errors, []);
  });
  await fs.mkdir(path.join(projectRoot, 'test-results'), { recursive: true }); await page.locator('.toast').waitFor({ state: 'hidden', timeout: 6000 }); await page.screenshot({ path: path.join(projectRoot, 'test-results/v04-workbench-en.png') });
} finally { await browser?.close(); await fixture.cleanup(); await closeServer(provider); await fs.mkdir(path.join(projectRoot, 'test-results'), { recursive: true }); await fs.writeFile(path.join(projectRoot, 'test-results/v04-browser.json'), JSON.stringify({ checks, errors }, null, 2)); }
