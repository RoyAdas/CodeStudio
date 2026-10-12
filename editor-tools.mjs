import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSensitiveMentorPath } from './mentor-shared.mjs';
export function applyTextEdits(content, edits) {
  const offset = position => { const lines = content.split('\n'); if (!Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.line >= lines.length || position.character < 0 || position.character > lines[position.line].replace(/\r$/, '').length) throw Error('语言服务返回了无效位置。'); return lines.slice(0, position.line).reduce((n, line) => n + line.length + 1, 0) + position.character; };
  const items = edits.map(edit => ({ start: offset(edit.range.start), end: offset(edit.range.end), text: edit.newText })); items.sort((a, b) => b.start - a.start);
  let boundary = content.length + 1; let result = content;
  for (const item of items) { if (item.start > item.end || item.end > boundary || typeof item.text !== 'string') throw Error('语言服务返回重叠或无效修改。'); result = result.slice(0, item.start) + item.text + result.slice(item.end); boundary = item.start; } return result;
}
export function createEditorTools({ home, getWorkspace, workspace, safePath, projectState, languages, capture }) {
  async function preview(input) {
    const file = await safePath(input.path); if (isSensitiveMentorPath(input.path)) throw Error('不能处理敏感文件。');
    const content = typeof input.content === 'string' ? input.content : await workspace.read(input.path);
    if (content.length > 2 * 1024 * 1024 || content.includes('\0')) throw Error('文件过大或不是文本。');
    const language = /\.py$/i.test(input.path) ? 'python' : /\.(c|cpp|cc|cxx|h|hpp)$/i.test(input.path) ? 'cpp' : 'other';
    if (input.action === 'format' && language === 'python') {
      const info = await projectState(); if (!info.tools.python.available) throw Error('请先配置 Python。');
      const raw = await capture(info.tools.python.path, [path.join(home, 'python-tools.py')], JSON.stringify({ action: 'format', content }), 30000);
      const after = JSON.parse(raw).content; return { summary: 'Python 格式化预览', changes: [{ path: input.path, before: content, after, reason: 'Black' }] };
    }
    if (input.action === 'format' && language === 'other') {
      const prettier = await import('prettier'); const after = await prettier.format(content, { filepath: file, tabWidth: 4 });
      return { summary: '格式化预览', changes: [{ path: input.path, before: content, after, reason: 'Prettier' }] };
    }
    if (input.action === 'rename' && (!['python', 'cpp'].includes(language) || typeof input.newName !== 'string' || !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(input.newName))) throw Error('请输入合法的 Python/C/C++ 符号名称。');
    const drafts = (input.drafts || []).filter(item => !isSensitiveMentorPath(item.path));
    const files = [...drafts.filter(item => item.path !== input.path), { path: input.path, content }].map(item => ({ ...item, version: 1 }));
    await languages.sync({ files });
    const response = await languages.query({ path: input.path, version: 1, method: input.action === 'rename' ? 'textDocument/rename' : 'textDocument/formatting', position: input.position || { line: 0, character: 0 }, newName: input.newName });
    if (response.stale) throw Error('代码版本已变化，请重试。');
    if (input.action === 'format') return { summary: 'C/C++ 格式化预览', changes: [{ path: input.path, before: content, after: applyTextEdits(content, response.result || []), reason: 'clangd' }] };
    const result = response.result || {}; const entries = [...Object.entries(result.changes || {}), ...(result.documentChanges || []).map(item => { if (!item.textDocument || !Array.isArray(item.edits)) throw Error('重命名不允许创建或删除文件。'); return [item.textDocument.uri, item.edits]; })];
    if (!entries.length || entries.length > 60) throw Error('此符号无法重命名或受影响文件过多。');
    const changes = [];
    for (const [uri, edits] of entries) {
      const relative = path.relative(getWorkspace(), fileURLToPath(uri)).replaceAll('\\', '/'); await safePath(relative); if (isSensitiveMentorPath(relative)) throw Error('重命名涉及敏感文件。');
      const before = files.find(item => item.path === relative)?.content ?? await workspace.read(relative);
      changes.push({ path: relative, before, after: applyTextEdits(before, edits), reason: input.newName });
    }
    return { summary: '符号重命名预览', changes };
  }
  return { preview };
}
