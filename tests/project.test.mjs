import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeProject } from '../project.mjs';
import { createFixture, eventually } from './helpers.mjs';

test('project configuration rejects traversal, absolute paths, invalid standards and unsupported sources', () => {
  for (const input of [
    { python: { venv: '..' } }, { python: { venv: '.' } }, { python: { venv: 'outside/environment' } },
    { python: { venv: 'CON' } },
    { build: { c: ['../outside.c'] } }, { build: { c: ['C:\\private.c'] } }, { build: { cpp: ['/tmp/source.cpp'] } },
    { build: { c: ['main.py'] } }, { build: { includeDirs: ['../include'] } }, { build: { cStandard: '-fplugin=unsafe' } },
    { version: 2 }, { python: [] },
  ]) {
    assert.throws(() => normalizeProject(input));
  }
  assert.deepEqual(normalizeProject({ build: { c: ['src\\main.c', 'src/main.c'], cpp: ['main.cpp', 'helper.c'] } }).build.c, ['src/main.c']);
});

test('linked environment folders and linked source directories cannot escape the selected workspace', async t => {
  const fixture = await createFixture({ files: { 'main.c': 'int main(void) { return 0; }\n' } }); t.after(() => fixture.cleanup()); await fixture.start();
  const outside = path.join(fixture.root, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'untouched'); await fs.writeFile(path.join(outside, 'outside.c'), '#error private source\n');
  await fs.symlink(outside, path.join(fixture.root, 'workspace/external'), process.platform === 'win32' ? 'junction' : 'dir');
  await fixture.call('project', { python: { mode: 'venv', venv: 'external' } });
  assert.equal((await fixture.call('project')).value.tools.python.available, false);
  const created = await fixture.call('project/venv', {}); assert.equal(created.status, 403);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'untouched');
  await fixture.call('project', { build: { c: ['main.c', 'external/outside.c'] } });
  assert.equal((await fixture.call('run', { path: 'main.c' })).status, 403);
});

test('project settings persist per workspace and malformed configurations block runs without destroying the file', async t => {
  const fixture = await createFixture({ files: { 'main.py': 'print(1)\n' } }); t.after(() => fixture.cleanup()); await fixture.start();
  const saved = await fixture.call('project', { python: { mode: 'system', venv: '.env-project' }, build: { c: ['main.c'] } });
  assert.equal(saved.status, 200); assert.equal(saved.value.project.exists, true);
  const first = path.join(fixture.root, 'workspace'); const other = path.join(fixture.root, 'second-workspace');
  await fs.mkdir(other);
  assert.equal((await fixture.call('workspace', { path: other })).value.project.exists, false);
  assert.equal((await fixture.call('project')).value.project.config.python.mode, 'auto');
  assert.equal((await fixture.call('workspace', { path: first })).value.project.config.python.mode, 'system');
  const invalid = '{"version": 1, broken'; await fs.writeFile(path.join(first, '.codestudio.json'), invalid);
  assert.match((await fixture.call('state')).value.project.error, /JSON/);
  assert.equal((await fixture.call('run', { path: 'main.py' })).status, 400);
  assert.equal(await fs.readFile(path.join(first, '.codestudio.json'), 'utf8'), invalid);
  assert.equal((await fixture.call('project', { build: { c: ['../../outside.c'] } })).status, 400);
});

test('Python environment creation uses local Python, preserves existing directories and switches modes correctly', async t => {
  const fixture = await createFixture({ files: { 'main.py': 'import sys\nprint(sys.executable)\nprint("IS_VENV", sys.prefix != sys.base_prefix)\n' } });
  t.after(() => fixture.cleanup()); await fixture.start();
  const state = (await fixture.call('state')).value;
  if (!state.tools.python.available) { t.skip('Install Python to exercise real virtual environments.'); return; }
  assert.equal(state.tools.python.environment, 'system');
  await fixture.call('project', { python: { mode: 'venv', venv: '.venv-test' } });
  assert.equal((await fixture.call('project')).value.tools.python.available, false);
  const created = await fixture.call('project/venv', {}, { signal: AbortSignal.timeout(190000) });
  assert.equal(created.status, 200, created.value.error); assert.equal(created.value.project.environmentBusy, false);
  assert.equal(created.value.tools.python.available, true); assert.equal(created.value.tools.python.environment, 'venv');
  assert.equal((await fixture.call('run', { path: 'main.py' })).status, 200);
  await eventually(async () => (await fixture.call('state')).value.run?.phase === 'finished');
  let run = (await fixture.call('state')).value.run;
  assert.equal(run.code, 0); assert.match(run.output, /IS_VENV True/); assert.match(run.output, /\.venv-test/);
  const marker = path.join(fixture.root, 'workspace/.venv-test/keep.txt'); await fs.writeFile(marker, 'user data');
  assert.equal((await fixture.call('project/venv', {})).status, 409); assert.equal(await fs.readFile(marker, 'utf8'), 'user data');
  const entries = (await fixture.call('state')).value.tree.entries;
  assert.equal(entries.some(entry => entry.name === '.venv-test'), false);
  await fixture.call('project', { python: { mode: 'system', venv: '.venv-test' } });
  assert.equal((await fixture.call('run', { path: 'main.py' })).status, 200);
  await eventually(async () => (await fixture.call('state')).value.run?.phase === 'finished');
  run = (await fixture.call('state')).value.run; assert.equal(run.code, 0); assert.match(run.output, /IS_VENV False/);
  assert.equal((await fixture.call('project')).value.tools.python.path, state.tools.python.path);
});

test('auto Python selects an existing project environment even when the configured system tool is missing', async t => {
  const fixture = await createFixture({ files: { 'main.py': 'print("existing env")\n' } }); t.after(() => fixture.cleanup()); await fixture.start();
  if (!(await fixture.call('state')).value.tools.python.available) { t.skip('Python required.'); return; }
  const created = await fixture.call('project/venv', {}, { signal: AbortSignal.timeout(190000) }); assert.equal(created.status, 200, created.value.error);
  await fixture.call('settings', { tools: { python: path.join(fixture.root, 'missing-python.exe'), c: '', cpp: '' } });
  const effective = (await fixture.call('state')).value.tools.python; assert.equal(effective.environment, 'venv'); assert.equal(effective.available, true);
});

test('C and C++ projects compile separate Unicode source directories, shared headers and mixed C/C++ sources', async t => {
  const files = {
    '公共头文件/value.h': '#ifdef __cplusplus\nextern "C" {\n#endif\nint value(void);\n#ifdef __cplusplus\n}\n#endif\n',
    '入口 目录/主程序.c': '#include <stdio.h>\n#include "value.h"\nint main(void) { printf("Project C: %d\\n", value()); return 0; }\n',
    '实现 目录/计算.c': '\uFEFF#include "value.h"\nint value(void) { return 42; }\n',
    '入口 目录/主程序.cpp': '#include <iostream>\n#include "value.h"\nint main() { std::cout << "Project C++: " << value() << "\\n"; }\n',
    'unselected.c': '#error This unselected file must never be compiled\n',
  };
  const fixture = await createFixture({ files }); t.after(() => fixture.cleanup()); await fixture.start();
  const tools = (await fixture.call('state')).value.tools;
  if (!tools.c.available || !tools.cpp.available) { t.skip('Install GCC/Clang C and C++ compilers.'); return; }
  const config = { build: { c: ['入口 目录/主程序.c', '实现 目录/计算.c'], cpp: ['入口 目录/主程序.cpp', '实现 目录/计算.c'], includeDirs: ['公共头文件'] } };
  assert.equal((await fixture.call('project', config)).status, 200);
  for (const [file, expected] of [['入口 目录/主程序.c', 'Project C: 42'], ['入口 目录/主程序.cpp', 'Project C++: 42']]) {
    assert.equal((await fixture.call('run', { path: file })).status, 200);
    await eventually(async () => (await fixture.call('state')).value.run?.phase === 'finished', 30000);
    const run = (await fixture.call('state')).value.run; assert.equal(run.code, 0, run.output); assert.match(run.output, new RegExp(expected.replace(/\+/g, '\\+')));
    const all = await fs.readdir(path.join(fixture.root, 'workspace'), { recursive: true });
    assert.equal(all.some(name => path.basename(name).startsWith('.studio-build-')), false);
    for (const [source, content] of Object.entries(files)) assert.equal(await fs.readFile(path.join(fixture.root, 'workspace', source), 'utf8'), content);
  }
  assert.equal((await fixture.call('run', { path: 'unselected.c' })).status, 400);
});

test('project compilation errors keep original filenames and lines and clean all temporary objects', async t => {
  const fixture = await createFixture({ files: { 'main.c': 'int helper(void);\nint main(void) { return helper(); }\n', '子目录/错误.c': 'int helper(void) {\n#error Studio original source line\nreturn 0;\n}\n' } });
  t.after(() => fixture.cleanup()); await fixture.start();
  if (!(await fixture.call('state')).value.tools.c.available) { t.skip('C compiler required.'); return; }
  await fixture.call('project', { build: { c: ['main.c', '子目录/错误.c'] } });
  assert.equal((await fixture.call('run', { path: 'main.c' })).status, 200);
  await eventually(async () => (await fixture.call('state')).value.run?.phase === 'finished', 30000);
  const run = (await fixture.call('state')).value.run; assert.notEqual(run.code, 0); assert.match(run.output, /错误\.c:2:/);
  const all = await fs.readdir(path.join(fixture.root, 'workspace'), { recursive: true });
  assert.equal(all.some(name => path.basename(name).startsWith('.studio-build-')), false);
});

test('stopping a multi-file process cleans build files and concurrent run or project changes are rejected', async t => {
  const fixture = await createFixture({ files: {
    'main.c': '#include <stdio.h>\nint value(void);\nint main(void) { printf("WAIT_FOR_INPUT %d\\n", value()); fflush(stdout); getchar(); return 0; }\n',
    'value.c': 'int value(void) { return 42; }\n',
  } }); t.after(() => fixture.cleanup()); await fixture.start();
  if (!(await fixture.call('state')).value.tools.c.available) { t.skip('C compiler required.'); return; }
  await fixture.call('project', { build: { c: ['main.c', 'value.c'] } });
  const results = await Promise.all([fixture.call('run', { path: 'main.c' }), fixture.call('run', { path: 'main.c' })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  await eventually(async () => (await fixture.call('state')).value.run?.output.includes('WAIT_FOR_INPUT 42'), 30000);
  assert.equal((await fixture.call('project', {})).status, 409);
  assert.equal((await fixture.call('workspace', { path: fixture.root })).status, 409);
  assert.equal((await fixture.call('stop', {})).status, 200);
  await eventually(async () => (await fixture.call('state')).value.run?.phase === 'finished');
  assert.equal((await fixture.call('state')).value.run.stopped, true);
  const all = await fs.readdir(path.join(fixture.root, 'workspace'), { recursive: true });
  assert.equal(all.some(name => path.basename(name).startsWith('.studio-build-')), false);
});
