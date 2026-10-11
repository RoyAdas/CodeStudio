import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFixture, eventually, projectRoot } from './helpers.mjs';

const checks = []; const errors = []; const external = [];
const resultDir = path.join(projectRoot, 'test-results');
let browser; let page; let fixture;
async function openFile(name) { await page.locator('.file-tree').getByText(name, { exact: true }).click(); await page.locator('.breadcrumb').getByText(name, { exact: true }).waitFor(); }
async function edit(code) {
  await page.getByRole('textbox', { name: '代码编辑器', exact: true }).focus();
  await page.keyboard.press('Control+A'); await page.evaluate(value => navigator.clipboard.writeText(value), code); await page.keyboard.press('Control+V');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function run() {
  const old = (await fixture.call('state')).value.run?.id;
  await page.keyboard.press('F5');
  await eventually(async () => { const state = (await fixture.call('state')).value; return state.run?.id !== old && state.run?.phase === 'finished'; }, 30000);
  return (await fixture.call('state')).value.run;
}
async function project() { await page.getByRole('button', { name: '项目设置', exact: true }).click(); await page.getByRole('dialog', { name: '项目设置', exact: true }).waitFor(); }
async function save() { await page.getByRole('button', { name: '保存项目设置', exact: true }).click(); await page.getByRole('status').filter({ hasText: '项目配置已保存' }).waitFor(); }
async function close() { await page.getByRole('button', { name: '关闭项目设置', exact: true }).click(); }

try {
  await fs.mkdir(resultDir, { recursive: true });
  fixture = await createFixture({ requireDist: true, files: {
    'main.py': 'import sys\nprint("IS_VENV", sys.prefix != sys.base_prefix)\n',
    'main.c': '#include <stdio.h>\n#include "value.h"\nint main(void) { printf("Browser C: %d\\n", value()); return 0; }\n',
    'helper.c': '#include "include/value.h"\nint value(void) { return 1; }\n',
    'main.cpp': '#include <iostream>\n#include "value.h"\nint main() { std::cout << "Browser C++: " << value() << "\\n"; }\n',
    'include/value.h': '#ifdef __cplusplus\nextern "C" {\n#endif\nint value(void);\n#ifdef __cplusplus\n}\n#endif\n',
    'single.c': '#include <stdio.h>\nint main(void) { puts("Single C OK"); return 0; }\n',
  }, settings: { tools: { python: process.env.STUDIO_TEST_PYTHON || '', c: process.env.STUDIO_TEST_CC || '', cpp: process.env.STUDIO_TEST_CXX || '' } } });
  const base = await fixture.start(); const initial = (await fixture.call('state')).value;
  for (const tool of ['python', 'c', 'cpp']) assert.equal(initial.tools[tool].available, true, `Install ${tool} to run project browser tests.`);
  browser = await chromium.launch({ headless: true, ...(process.env.STUDIO_BROWSER_EXECUTABLE ? { executablePath: process.env.STUDIO_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1536, height: 960 } }); await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:') && !request.url().startsWith('blob:')) external.push(request.url()); });
  await page.goto(base); await page.locator('.monaco-editor .view-lines').waitFor();
  await project(); await page.getByRole('button', { name: 'C / C++ 构建', exact: true }).click();
  for (const name of ['C 构建 main.c', 'C 构建 helper.c', 'C++ 构建 main.cpp', 'C++ 构建 helper.c']) await page.getByRole('checkbox', { name, exact: true }).check();
  await page.getByRole('textbox', { name: '额外头文件目录' }).fill('include'); await save();
  const persisted = JSON.parse(await fs.readFile(path.join(fixture.root, 'workspace/.codestudio.json'), 'utf8'));
  assert.deepEqual(persisted.build.c.sort(), ['helper.c', 'main.c']); assert.deepEqual(persisted.build.cpp.sort(), ['helper.c', 'main.cpp']);
  checks.push('Source selection and header directories persist through the project settings UI');
  await page.screenshot({ path: path.join(resultDir, 'project-settings.png') });
  await close(); await openFile('helper.c'); await edit('#include "include/value.h"\nint value(void) { return 42; }\n');
  await openFile('main.c'); let result = await run(); assert.equal(result.code, 0, result.output); assert.match(result.output, /Browser C: 42/);
  assert.match(await fs.readFile(path.join(fixture.root, 'workspace/helper.c'), 'utf8'), /return 42/);
  checks.push('F5 saves dirty dependency files and builds the selected C project');
  await openFile('main.cpp'); result = await run(); assert.equal(result.code, 0, result.output); assert.match(result.output, /Browser C\+\+: 42/);
  checks.push('F5 links selected C and C++ sources as a C++ project');
  await project(); await page.getByRole('button', { name: 'C / C++ 构建', exact: true }).click();
  for (const name of ['C 构建 main.c', 'C 构建 helper.c']) await page.getByRole('checkbox', { name, exact: true }).uncheck();
  await save(); await close(); await openFile('single.c'); result = await run(); assert.equal(result.code, 0, result.output); assert.match(result.output, /Single C OK/);
  checks.push('Empty source lists preserve single-file execution');
  await project(); await page.getByRole('combobox', { name: 'Python 运行方式' }).selectOption('venv');
  await page.getByRole('textbox', { name: '虚拟环境文件夹' }).fill('.venv-browser'); await save();
  await page.getByRole('button', { name: '保存配置并创建虚拟环境', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已创建' }).waitFor({ timeout: 190000 });
  assert.equal((await fixture.call('state')).value.tools.python.environment, 'venv');
  checks.push('The UI creates an offline Python virtual environment and detects its interpreter');
  const marker = path.join(fixture.root, 'workspace/.venv-browser/keep.txt'); await fs.writeFile(marker, 'keep existing user data');
  await page.getByRole('button', { name: '保存配置并创建虚拟环境', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '目录已经存在' }).waitFor(); assert.equal(await fs.readFile(marker, 'utf8'), 'keep existing user data');
  checks.push('Creating an environment never overwrites an existing environment directory');
  await close(); await openFile('main.py'); result = await run(); assert.equal(result.code, 0, result.output); assert.match(result.output, /IS_VENV True/);
  checks.push('F5 runs Python inside the configured project environment');
  await project(); await page.getByRole('combobox', { name: 'Python 运行方式' }).selectOption('system'); await save(); await close();
  result = await run(); assert.equal(result.code, 0, result.output); assert.match(result.output, /IS_VENV False/);
  checks.push('Switching to system Python changes the actual interpreter used by F5');
  await page.reload(); await page.locator('.monaco-editor .view-lines').waitFor(); await project();
  assert.equal(await page.getByRole('combobox', { name: 'Python 运行方式' }).inputValue(), 'system');
  await page.getByRole('button', { name: 'C / C++ 构建', exact: true }).click(); assert.equal(await page.getByRole('checkbox', { name: 'C++ 构建 helper.c', exact: true }).isChecked(), true);
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(fixture.log, '');
  checks.push('Reload restores project settings and all editor assets remain local');
  const report = { passed: checks.length, checks }; await fs.writeFile(path.join(resultDir, 'project-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(resultDir, 'project-failure.png') }).catch(() => {});
  console.error(JSON.stringify({ completed: checks, errors, serviceLog: fixture?.log || '' })); throw error;
} finally { if (browser) await browser.close(); if (fixture) await fixture.cleanup(); }
