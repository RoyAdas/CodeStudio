import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createFixture, listen, closeServer, sleep, eventually, projectRoot } from './helpers.mjs';

const checks = []; const errors = []; const requests = []; let canceled = false;
const provider = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk; const input = JSON.parse(raw); requests.push(input);
  const system = input.messages?.[0]?.content || ''; const user = input.messages?.at(-1)?.content || '';
  if (system.includes('把任务拆成')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'Learn totals', overview: 'One step at a time.', steps: [{ title: 'Sum values', goal: 'Implement total.', hint: 'Think about accumulation.', acceptance: 'Returns the sum.' }, { title: 'Empty input', goal: 'Handle empty lists.', hint: 'Try zero.', acceptance: 'Returns zero.' }] }) } }] })); return; }
  if (system.includes('只检查当前步骤')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'in_progress', note: 'Static review only.', hint: system.includes('短代码示例') ? 'A small example:\n```python\nresult = sum([1, 2])\n```' : 'Try accumulating values.', evidence: [] }) } }] })); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const write = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  write({ choices: [{ delta: { content: 'Visible first chunk' } }] });
  const timer = setTimeout(() => { if (!res.destroyed) { write({ choices: [{ delta: { content: ' and final chunk.' }, finish_reason: 'stop' }] }); res.end('data: [DONE]\n\n'); } }, user === 'cancel me' ? 10000 : 1500);
  res.on('close', () => { clearTimeout(timer); if (user === 'cancel me') canceled = true; });
});
const providerBase = await listen(provider);
const fixture = await createFixture({ requireDist: true, requireLanguages: true, settings: { baseUrl: providerBase }, files: { 'main.py': 'from helper import greet\nvalues: list[str] = []\nprint(greet("Ada"))\n', 'helper.py': 'def greet(name: str) -> str:\n    return "Hello " + name\n' } });
let browser; let page;
async function check(name, run) { await run(); checks.push(name); console.log('PASS ' + name); }
async function code(value) { await page.locator('.monaco-editor').first().click(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(value); }
async function call(route, data) { return page.evaluate(async ({ route, data }) => { const token = document.querySelector('meta[name="studio-token"]').content; const response = await fetch('/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-Studio-Token': token, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return response.json(); }, { route, data }); }
try {
  await fixture.start(); browser = await chromium.launch({ headless: true, ...(process.env.STUDIO_BROWSER_EXECUTABLE ? { executablePath: process.env.STUDIO_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } }); page.on('pageerror', error => errors.push(error.message));
  const external = []; page.on('request', request => { const url = new URL(request.url()); if (!['127.0.0.1', 'localhost'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol)) external.push(request.url()); });
  await page.goto(fixture.base); await page.locator('.monaco-editor textarea').first().waitFor();
  await check('English interface switches immediately, persists across refresh, and switches back', async () => {
    await page.getByLabel('界面语言').selectOption('en'); await page.getByRole('button', { name: 'Open settings', exact: true }).waitFor(); assert.equal((await call('state')).settings.locale, 'en');
    await page.reload(); await page.getByRole('button', { name: 'Open settings', exact: true }).waitFor();
    await page.getByLabel('Interface language').selectOption('zh-CN'); await page.getByRole('button', { name: '打开设置', exact: true }).waitFor();
    await page.getByLabel('界面语言').selectOption('en'); await page.getByRole('button', { name: 'Open settings', exact: true }).waitFor();
  });
  await check('Real Python member completion is shown inside Monaco', async () => {
    await code('values: list[str] = []\nvalues.'); await page.keyboard.press('Control+Space');
    await page.locator('.suggest-widget').filter({ hasText: 'append' }).waitFor({ timeout: 25000 }); await page.keyboard.press('Escape');
  });
  await check('Unsaved Python type errors appear in the clickable problems panel', async () => {
    await code('answer: int = "wrong"\n'); await page.getByRole('button', { name: /^Problems/ }).click();
    await page.getByLabel('Code problems').getByText(/not assignable|incompatible/i).first().waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Ask mentor', exact: true }).first().waitFor();
  });
  await check('F12 opens a definition in another local file', async () => {
    await code('from helper import greet\nprint(greet("Ada"))\n'); await page.keyboard.press('Control+Home');
    for (let i = 0; i < 21; i++) await page.keyboard.press('ArrowRight'); await page.keyboard.press('F12');
    await page.locator('.editor-tab.active').filter({ hasText: 'helper.py' }).waitFor({ timeout: 20000 });
  });
  await check('Chat displays partial text before completion and stopping cancels the provider request', async () => {
    await page.getByRole('button', { name: 'Chat', exact: true }).click(); await page.getByLabel('Ask AI').fill('cancel me'); await page.getByRole('button', { name: 'Send AI message', exact: true }).click();
    await page.locator('.chat-message.assistant').getByText('Visible first chunk', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Stop generation', exact: true }).click();
    await page.getByRole('button', { name: 'Retry last message', exact: true }).waitFor(); await eventually(() => canceled);
    await page.getByLabel('Ask AI').fill('finish this'); await page.getByRole('button', { name: 'Send AI message', exact: true }).click(); await page.getByText('Visible first chunk and final chunk.', { exact: true }).waitFor();
  });
  await check('Three mentor hint levels request a small example and display code correctly', async () => {
    await page.locator('.ai-tabs').getByRole('button', { name: 'Live mentor', exact: true }).click(); await page.getByLabel('Mentor task').fill('Teach me to sum values'); await page.getByRole('button', { name: 'Submit task and start learning', exact: true }).click();
    await page.getByLabel('Mentor automatic checks').selectOption('manual'); await page.getByLabel('Mentor hint depth').selectOption('example'); await page.getByRole('button', { name: 'Review this step', exact: true }).click();
    await page.locator('.hint-content pre').getByText('result = sum([1, 2])', { exact: true }).waitFor(); assert.ok(requests.at(-1).messages[0].content.includes('短代码示例'));
    await page.getByLabel('Mentor hint depth').selectOption('hint'); await page.getByRole('button', { name: 'Review this step', exact: true }).click(); await page.getByText('Try accumulating values.', { exact: true }).waitFor();
  });
  await check('Encrypted backup can be downloaded and the settings page exposes legacy migration', async () => {
    // Save all modified open files before exercising restoration controls.
    for (const button of await page.locator('.editor-tab .dirty-dot').all()) await button.click();
    await page.getByRole('button', { name: 'Open settings', exact: true }).click(); await page.getByRole('button', { name: 'Upgrade & backup', exact: true }).click();
    const downloadEvent = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export encrypted backup', exact: true }).click(); const download = await downloadEvent;
    const backup = JSON.parse(await fs.readFile(await download.path(), 'utf8')); assert.equal(backup.format, 'CodeStudio encrypted backup'); assert.ok(backup.encryptedData); assert.equal(backup.settings, undefined);
    await page.getByLabel('Old workbench folder').waitFor(); await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  });
  await check('No external editor resources or browser exceptions', async () => { assert.deepEqual(external, []); assert.deepEqual(errors, []); });
  await fs.mkdir(path.join(projectRoot, 'test-results'), { recursive: true }); await page.locator('.toast').waitFor({ state: 'hidden', timeout: 6000 }); await page.screenshot({ path: path.join(projectRoot, 'test-results/v03-workbench-en.png') });
} finally {
  await browser?.close(); await fixture.cleanup(); await closeServer(provider);
  await fs.mkdir(path.join(projectRoot, 'test-results'), { recursive: true }); await fs.writeFile(path.join(projectRoot, 'test-results/v03-browser.json'), JSON.stringify({ checks, errors }, null, 2));
}
