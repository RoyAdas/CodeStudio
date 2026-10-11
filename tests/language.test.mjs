import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, eventually } from './helpers.mjs';
test('real language services: Python and C/C++ completion, signatures, hover, cross-file definitions, unsaved errors and stale queries', { timeout: 90000 }, async t => {
  const python = 'from helper import greet\nvalues: list[str] = ["Ada"]\nvalues.\ngreet("Ada")\n';
  const c = '#include "item.h"\nint main(void){struct Item item; item.; return 0;}\n';
  const cpp = '#include "widget.hpp"\nint main(){Widget widget; widget.; return 0;}\n';
  const fixture = await createFixture({ requireLanguages: true, files: { 'main.py': python, 'helper.py': 'def greet(name: str) -> str:\n    return "Hello " + name\n', '中文/main.c': c, '中文/item.h': 'struct Item { int score; };\n', '中文/main.cpp': cpp, '中文/widget.hpp': 'struct Widget { int score; void hello(); };\n' } });
  t.after(() => fixture.cleanup()); await fixture.start();
  const sync = files => fixture.call('language/sync', { files });
  const query = async (path, method, line, character, version = 1) => {
    const response = await fixture.call('language/query', { path, method: 'textDocument/' + method, version, position: { line, character } }); assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value.result;
  };
  const files = [{ path: 'main.py', content: python, version: 1 }, { path: '中文/main.c', content: c, version: 1 }, { path: '中文/main.cpp', content: cpp, version: 1 }];
  const started = await sync(files); assert.equal(started.value.services.python.available, true, JSON.stringify(started.value)); assert.equal(started.value.services.cpp.available, true, JSON.stringify(started.value));
  await eventually(async () => { const value = await query('main.py', 'completion', 2, 7); return (value?.items || value || []).some(x => x.label === 'append'); }, 20000);
  // Complete the member expression before checking the next line's call.
  files[0] = { path: 'main.py', content: python.replace('values.\n', 'values.append("B")\n'), version: 2 }; await sync(files);
  await eventually(async () => !!(await query('main.py', 'signatureHelp', 3, 6, 2))?.signatures?.length, 20000);
  assert.ok((await query('main.py', 'hover', 0, 20, 2))?.contents);
  assert.ok((await query('main.py', 'definition', 0, 20, 2)).some(x => x.path === 'helper.py'));
  for (const [name, source, label] of [['中文/main.c', c, 'score'], ['中文/main.cpp', cpp, 'hello']]) {
    const position = source.split('\n')[1].indexOf(name.endsWith('.c') ? 'item.' : 'widget.') + (name.endsWith('.c') ? 5 : 7);
    await eventually(async () => { const value = await query(name, 'completion', 1, position); return (value?.items || value || []).some(x => x.label.includes(label)); }, 20000);
  }
  const definition = await query('中文/main.cpp', 'definition', 1, 12); assert.ok(definition.some(x => x.path === '中文/widget.hpp'), JSON.stringify(definition));
  files[0] = { path: 'main.py', content: 'answer: int = "wrong"\n', version: 3 }; await sync(files);
  await eventually(async () => (await sync(files)).value.diagnostics.some(x => x.path === 'main.py' && x.version === 3 && x.markers.some(m => m.severity === 'error')), 20000);
  const stale = await fixture.call('language/query', { path: 'main.py', method: 'textDocument/hover', version: 1, position: { line: 0, character: 1 } }); assert.equal(stale.value.stale, true);
  assert.notEqual((await fixture.call('language/query', { path: '../outside.py', method: 'workspace/executeCommand', version: 1, position: { line: 0, character: 0 } })).status, 200);
});
