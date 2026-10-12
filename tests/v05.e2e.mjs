import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { createFixture, listen, closeServer, projectRoot, eventually } from './helpers.mjs';
const checks = []; const errors = [];
const provider = http.createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw); const system = body.messages[0].content;
  const content = system.includes('把任务拆成') ? JSON.stringify({ title: 'Practice totals', overview: 'Learn sums', steps: [{ title: 'Handle empty input', goal: 'Return a total', hint: 'Start with zero', acceptance: 'Tests pass' }] }) : system.includes('只检查当前步骤') ? JSON.stringify({ status: 'needs_fix', note: 'Try empty input', hint: 'Check the boundary', evidence: [] }) : 'Practice review: use an empty-input test.';
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
const base = await listen(provider);
const fixture = await createFixture({ requireDist: true, requireLanguages: true, settings: { baseUrl: base, locale: 'en' }, files: { 'main.py': 'def total(values):\n    if values:\n        return sum(values)\n    return 0\n', 'helper.py': 'message = "hello world"\n', 'test_main.py': 'import pytest\nfrom main import total\n@pytest.mark.parametrize("values,expected", [([1,2],3),([3],3)])\ndef test_total(values,expected): assert total(values)==expected\n' } });
let browser; let page;
async function check(name, run) { await run(); checks.push(name); console.log('PASS ' + name); }
async function open(tab) { await page.getByRole('button', { name: 'Toolbox', exact: true }).click(); if (tab) await page.getByRole('button', { name: tab, exact: true }).click(); }
async function close() { await page.getByRole('button', { name: 'Close toolbox', exact: true }).click(); }
try {
  await fixture.start(); browser = await chromium.launch({ headless: true, ...(process.env.STUDIO_BROWSER_EXECUTABLE ? { executablePath: process.env.STUDIO_BROWSER_EXECUTABLE } : {}) }); page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); page.on('pageerror', error => errors.push(error.message)); await page.goto(fixture.base); await page.locator('.monaco-editor textarea').first().waitFor();
  await check('Project search, literal replacement and formatting use a difference preview', async () => {
    await open(); await page.getByLabel('Search text', { exact: true }).fill('hello'); await page.getByRole('button', { name: 'Search project content', exact: true }).click(); await page.locator('.tool-results').getByText('helper.py:1', { exact: true }).waitFor();
    await page.getByLabel('Replacement text').fill('goodbye'); await page.getByRole('button', { name: 'Preview multi-file replacement', exact: true }).click(); await page.getByRole('button', { name: 'Accept selected changes', exact: true }).waitFor(); assert.equal(await fs.readFile(path.join(fixture.root, 'workspace/helper.py'), 'utf8'), 'message = "hello world"\n'); await page.getByRole('button', { name: 'Accept selected changes', exact: true }).click(); await page.keyboard.press('Control+S');
    await eventually(async () => (await fs.readFile(path.join(fixture.root, 'workspace/helper.py'), 'utf8')).includes('goodbye'));
    await open(); await page.getByRole('button', { name: 'Preview formatting', exact: true }).click(); await page.getByRole('button', { name: 'Reject changes', exact: true }).click();
  });
  await check('Local code history opens a previous version without silently restoring disk files', async () => {
    await open('Code history'); await page.getByRole('button', { name: 'Compare and restore', exact: true }).first().waitFor(); await page.getByRole('button', { name: 'Compare and restore', exact: true }).last().click(); await page.getByRole('button', { name: 'Accept selected changes', exact: true }).waitFor(); await page.getByRole('button', { name: 'Reject changes', exact: true }).click(); assert.match(await fs.readFile(path.join(fixture.root, 'workspace/helper.py'), 'utf8'), /goodbye/);
  });
  await check('Context picker shows exact scope and includes a file that is not open', async () => {
    await open('AI context'); await page.getByLabel('test_main.py', { exact: true }).check(); await page.getByLabel('main.py', { exact: true }).check(); await page.getByRole('button', { name: 'Check sending scope', exact: true }).click(); await page.getByText(/Chat context: 2 files/).waitFor(); await page.getByRole('button', { name: 'Use selected context', exact: true }).click();
  });
  await check('AI profiles can be saved and assigned to different feature routes', async () => {
    await open('AI profiles'); await page.getByLabel('Configuration name').fill('Teacher profile'); await page.getByLabel('Configuration API URL').fill(base); await page.getByLabel('Configuration model', { exact: true }).fill('teacher-model'); await page.getByLabel('Endpoint needs no key').check(); await page.getByRole('button', { name: 'Save AI configuration', exact: true }).click();
    await page.locator('.tool-row').filter({ hasText: 'Teacher profile' }).waitFor(); const id = (await fixture.call('profiles')).value.profiles[0].id; await page.getByLabel('Mentor provider').selectOption(id); await page.getByLabel('Completion provider').selectOption(id); await close(); assert.equal((await fixture.call('profiles')).value.routes.mentor, id);
  });
  await check('Git GUI initializes a repository, stages a file and creates a local commit', async () => {
    await open('Git management'); await page.getByRole('button', { name: 'Initialize current repository', exact: true }).click(); await page.getByLabel('Commit author name').fill('CodeStudio test'); await page.getByLabel('Commit author email').fill('tests@example.invalid'); await page.getByRole('button', { name: 'Set repository identity', exact: true }).click();
    await page.locator('.tool-row').filter({ has: page.getByText('?? · main.py', { exact: true }) }).getByRole('button', { name: 'Stage', exact: true }).click(); await page.getByLabel('Commit message').fill('Initial practice'); await page.getByRole('button', { name: 'Commit staged changes', exact: true }).click(); await page.getByText('Initial practice', { exact: true }).waitFor(); await close();
  });
  await check('pytest and branch coverage are available from the existing test panel', async () => {
    await page.getByRole('button', { name: 'Tests', exact: true }).click(); await page.getByLabel('Test framework').selectOption('pytest'); await page.getByLabel('Record branch coverage').check(); const started = page.waitForResponse(response => response.url().endsWith('/api/tests/start')); await page.getByRole('button', { name: 'Save and run tests', exact: true }).click(); const response = await started; assert.equal(response.status(), 200, JSON.stringify(await response.json()) + fixture.log); await page.getByText('Passed 2 / 2', { exact: true }).waitFor(); await page.getByText(/Test coverage/).waitFor(); assert.ok((await fixture.call('tests')).value.coverage.totals.missing_branches > 0);
  });
  await check('Learning mistakes and AI review drafts are displayed and saved only after confirmation', async () => {
    await page.getByLabel('Mentor task').fill('Teach me totals'); await page.getByRole('button', { name: 'Submit task and start learning', exact: true }).click(); await page.getByLabel('Mentor automatic checks').selectOption('manual'); await page.getByRole('button', { name: 'Review this step', exact: true }).click(); await page.getByText('Try empty input', { exact: true }).waitFor();
    await open('Learning review'); await page.getByText('Practice totals', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Generate AI review suggestions', exact: true }).click(); await page.getByLabel('Review draft').waitFor(); await page.getByLabel('Review draft').fill('I should test empty input.'); assert.equal((await fixture.call('learning')).value.tasks[0].recap, undefined); await page.getByRole('button', { name: 'Confirm and save review', exact: true }).click(); await eventually(async () => (await fixture.call('learning')).value.tasks[0].recap === 'I should test empty input.'); await close();
  });
  await check('Interactive terminal creates separate tabs and closes the chosen shell', async () => {
    await open('Interactive terminal'); await page.getByRole('button', { name: 'New PowerShell terminal', exact: true }).click(); await page.locator('.shell-host .xterm').waitFor(); await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('Write-Output ("BROWSER" + "_SHELL")'); await page.keyboard.press('Enter'); await eventually(async () => (await fixture.call('terminals')).value.sessions[0].output.includes('BROWSER_SHELL'));
    await page.getByRole('button', { name: 'Close this terminal', exact: true }).click(); await eventually(async () => (await fixture.call('terminals')).value.sessions.length === 0); await close();
  });
  await check('Update controls are manual and Chinese/English toolbox labels switch immediately', async () => {
    await open('Updates and rollback'); await page.getByRole('button', { name: 'Check GitHub updates', exact: true }).waitFor(); await page.getByLabel('Old installation folder').waitFor(); await close(); await page.getByLabel('Interface language').selectOption('zh-CN'); await page.getByRole('button', { name: '工具箱', exact: true }).click(); await page.getByRole('button', { name: '更新与回退', exact: true }).click(); await page.getByRole('button', { name: '检查 GitHub 更新', exact: true }).waitFor(); await page.getByRole('button', { name: '关闭工具箱', exact: true }).click(); await page.getByLabel('界面语言').selectOption('en');
  });
  await check('Project template wizard creates and opens an offline exercise with a mentor goal', async () => {
    await open('Project template'); await page.getByLabel('Project template', { exact: true }).selectOption('python-cli'); await page.getByLabel('Project name').fill('guided-practice'); await page.getByRole('button', { name: 'Create and open project', exact: true }).click(); await page.locator('.top-workspace').filter({ hasText: 'guided-practice' }).waitFor(); await eventually(async () => (await page.getByLabel('Mentor task').inputValue()).includes('word counter')); assert.ok(await fs.readFile(path.join(fixture.root, 'workspace/guided-practice/test_main.py'), 'utf8'));
  });
  assert.deepEqual(errors, []); await open('Project template'); await fs.mkdir(path.join(projectRoot, 'test-results'), { recursive: true }); await page.locator('.toast').waitFor({ state: 'hidden', timeout: 6000 }); await page.screenshot({ path: path.join(projectRoot, 'test-results/v05-toolbox-en.png') });
} catch (error) { await fs.mkdir(path.join(projectRoot, 'test-results'), { recursive: true }); await page?.screenshot({ path: path.join(projectRoot, 'test-results/v05-failure.png') }); throw error; } finally { await browser?.close(); await fixture.cleanup(); await closeServer(provider); await fs.mkdir(path.join(projectRoot, 'test-results'), { recursive: true }); await fs.writeFile(path.join(projectRoot, 'test-results/v05-browser.json'), JSON.stringify({ checks, errors }, null, 2)); }
