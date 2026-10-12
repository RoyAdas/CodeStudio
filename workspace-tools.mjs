import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isSensitiveMentorPath } from './mentor-shared.mjs';
const bad = (message, status = 400) => { const error = Error(message); error.status = status; throw error; };
const ignored = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.code-studio-build', 'data', 'dist', 'releases', '.pytest_cache', '.mypy_cache']);
export function createWorkspaceTools({ dataDir, getWorkspace, safePath, projectState }) {
  let queue = Promise.resolve();
  const locked = fn => { const next = queue.catch(() => {}).then(fn); queue = next; return next; };
  async function read(relative) {
    if (isSensitiveMentorPath(relative)) bad('敏感文件不参与此操作。');
    const file = await safePath(relative); const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) bad('文件不是文本或超过 2 MB。');
    const content = await fs.readFile(file, 'utf8'); if (content.includes('\0')) bad('不能处理二进制文件。'); return content;
  }
  async function list() {
    const entries = []; let scanned = 0;
    const environment = (await projectState()).project.config.python.venv;
    async function walk(dir, prefix = '', depth = 0) {
      if (depth > 12) return;
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        if (++scanned > 10000) bad('工作区文件过多，请缩小搜索范围。');
        const relative = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isSymbolicLink() || ignored.has(item.name) || item.name === environment || isSensitiveMentorPath(relative)) continue;
        if (item.isDirectory()) await walk(path.join(dir, item.name), relative, depth + 1);
        else if (item.isFile() && /\.(py|c|h|cpp|cc|cxx|hpp|hxx|js|mjs|ts|tsx|jsx|json|html|css|md|txt|csv|yml|yaml|toml|ini)$/i.test(item.name)) {
          if ((await fs.stat(path.join(dir, item.name))).size <= 2 * 1024 * 1024) entries.push(relative);
        }
      }
    }
    await walk(getWorkspace()); return entries.sort();
  }
  async function context(input = {}) {
    if (!Array.isArray(input.paths) || input.paths.length > 16) bad('上下文最多选择 16 个文件。');
    const drafts = new Map((input.drafts || []).slice(0, 32).map(file => [file.path, file.content]));
    const files = []; let characters = 0;
    for (const relative of [...new Set(input.paths)]) {
      const disk = await read(relative); const content = drafts.has(relative) ? drafts.get(relative) : disk;
      if (typeof content !== 'string' || content.includes('\0') || content.length > 50000) bad('所选上下文文件过大或无效。'); characters += content.length;
      if (characters > 120000) bad('上下文超过 120,000 字符，请减少选择。'); files.push({ path: relative, content });
    }
    return { files, characters, paths: files.map(file => file.path) };
  }
  async function search(input) {
    if (typeof input.query !== 'string' || !input.query || input.query.length > 500) bad('请输入 1–500 字符的搜索文字。');
    const candidates = await list(); const drafts = new Map((input.drafts || []).slice(0, 32).map(file => [file.path, file.content]));
    const results = []; const changes = []; let scanned = 0; let budget = 0; let truncated = false;
    for (const relative of candidates) {
      if (input.filter && !relative.toLowerCase().includes(String(input.filter).toLowerCase())) continue;
      const original = drafts.has(relative) ? drafts.get(relative) : await read(relative); if (typeof original !== 'string') continue;
      budget += original.length; if (budget > 30_000_000) { truncated = true; break; } scanned++;
      const haystack = input.caseSensitive ? original : original.toLowerCase(); const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
      let offset = 0; let at; const offsets = [];
      while ((at = haystack.indexOf(needle, offset)) >= 0) { offsets.push(at); offset = at + needle.length; if (results.length < 500) { const prefix = original.slice(0, at); results.push({ path: relative, line: prefix.split('\n').length, column: at - prefix.lastIndexOf('\n'), text: original.slice(at - (at - prefix.lastIndexOf('\n') - 1), original.indexOf('\n', at) < 0 ? original.length : original.indexOf('\n', at)).slice(0, 240) }); } else truncated = true; }
      if (input.replacement !== undefined && offsets.length) {
        if (typeof input.replacement !== 'string' || input.replacement.length > 5000 || changes.length >= 60) bad('替换内容或受影响文件过多。');
        let after = original; for (const index of offsets.reverse()) after = after.slice(0, index) + input.replacement + after.slice(index + input.query.length);
        changes.push({ path: relative, before: original, after, reason: `${offsets.length} matches` });
      }
    }
    return { results, scanned, truncated, ...(input.replacement !== undefined ? { summary: '搜索替换预览', changes } : {}) };
  }
  const historyFolder = relative => path.join(dataDir, 'file-history', crypto.createHash('sha256').update(getWorkspace().toLowerCase()).digest('hex'), crypto.createHash('sha256').update(relative.toLowerCase()).digest('hex'));
  async function record(relative, content, reason = 'save') {
    if (isSensitiveMentorPath(relative) || typeof content !== 'string' || content.length > 2 * 1024 * 1024 || content.includes('\0')) return;
    return locked(async () => {
      const folder = historyFolder(relative); await fs.mkdir(folder, { recursive: true });
      const hash = crypto.createHash('sha256').update(content).digest('hex'); const entries = (await fs.readdir(folder)).filter(name => /^\d+-[a-f0-9]{8}\.json$/.test(name)).sort();
      if (entries.length) { const latest = JSON.parse(await fs.readFile(path.join(folder, entries.at(-1)), 'utf8')); if (latest.hash === hash) return; }
      const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
      await fs.writeFile(path.join(folder, name), JSON.stringify({ path: relative, createdAt: new Date().toISOString(), reason, hash, content }), { flag: 'wx', mode: 0o600 });
      for (const name of entries.slice(0, Math.max(0, entries.length - 19))) await fs.unlink(path.join(folder, name));
    });
  }
  async function history(relative) {
    await safePath(relative, true); if (isSensitiveMentorPath(relative)) bad('敏感文件不记录历史。');
    const folder = historyFolder(relative); let names; try { names = await fs.readdir(folder); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(names.filter(name => /^\d+-[a-f0-9]{8}\.json$/.test(name)).sort().reverse().map(async name => { const item = JSON.parse(await fs.readFile(path.join(folder, name), 'utf8')); return { id: name, createdAt: item.createdAt, reason: item.reason, hash: item.hash, characters: item.content.length }; }));
  }
  async function historical(relative, id) {
    if (!/^\d+-[a-f0-9]{8}\.json$/.test(id || '')) bad('历史版本编号无效。'); await safePath(relative, true);
    const item = JSON.parse(await fs.readFile(path.join(historyFolder(relative), id), 'utf8')); if (item.path !== relative) bad('历史版本与文件不匹配。');
    const before = await read(relative); return { summary: '恢复代码历史', changes: [{ path: relative, before, after: item.content, reason: item.createdAt }] };
  }
  return { list, read, context, search, record, history, historical };
}
