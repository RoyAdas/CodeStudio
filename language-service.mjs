import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const allowedMethods = new Set(['textDocument/completion', 'textDocument/hover', 'textDocument/signatureHelp', 'textDocument/definition', 'textDocument/formatting', 'textDocument/rename']);
const kindFor = name => /\.py$/i.test(name) ? 'python' : /\.(c|cpp|cc|cxx|h|hpp|hxx)$/i.test(name) ? 'cpp' : null;
const uriOf = file => pathToFileURL(file).href;

class RPC {
  constructor(executable, args, cwd, notify) {
    this.child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map(); this.next = 1; this.buffer = Buffer.alloc(0); this.dead = false;
    this.child.stdin.on('error', () => {}); this.child.stderr.on('data', () => {});
    this.child.stdout.on('data', chunk => {
      if (this.dead) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 8_000_000) { this.close(); return; }
      while (true) {
        const header = this.buffer.indexOf('\r\n\r\n'); if (header < 0) break;
        const length = Number(/Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, header).toString())?.[1]);
        if (!Number.isInteger(length) || length < 0 || length > 8_000_000) { this.close(); return; }
        if (this.buffer.length < header + 4 + length) break;
        let message; try { message = JSON.parse(this.buffer.subarray(header + 4, header + 4 + length).toString()); } catch { this.close(); return; }
        this.buffer = this.buffer.subarray(header + 4 + length);
        if (message.method && message.id !== undefined) {
          // Servers ask for client configuration; no arbitrary tool execution.
          const result = message.method === 'workspace/configuration' ? (message.params?.items || []).map(item => item.section ? item.section.split('.').reduce((value, key) => value?.[key], this.settings) || {} : this.settings || {}) : null;
          this.send({ id: message.id, result });
        } else if (message.id !== undefined) {
          const entry = this.pending.get(message.id); if (entry) { this.pending.delete(message.id); entry.finish(message.error ? Error(message.error.message) : null, message.result); }
        } else if (message.method) notify(message.method, message.params);
      }
    });
    this.child.once('error', error => this.dispose(error));
    this.child.once('exit', () => this.dispose(Error('语言服务已停止，请重试。')));
  }
  send(message) { if (!this.dead) this.child.stdin.write(`Content-Length: ${Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', ...message }))}\r\n\r\n${JSON.stringify({ jsonrpc: '2.0', ...message })}`); }
  notify(method, params) { this.send({ method, params }); }
  request(method, params, signal) {
    if (this.dead) return Promise.reject(Error('语言服务不可用。'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const cancel = () => { this.notify('$/cancelRequest', { id }); this.pending.delete(id); finish(Error('语言查询已取消。')); };
      const timer = setTimeout(cancel, method === 'initialize' ? 20000 : 10000);
      const finish = (error, value) => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); error ? reject(error) : resolve(value); };
      this.pending.set(id, { finish }); signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel(); else this.send({ id, method, params });
    });
  }
  dispose(error = Error('语言服务已关闭。')) { if (this.dead) return; this.dead = true; for (const job of this.pending.values()) job.finish(error); this.pending.clear(); }
  close() { this.dispose(); this.child.kill(); }
}

export function createLanguageService({ home, dataDir, getWorkspace, safePath, projectState, broadcast }) {
  const sessions = new Map(); let queue = Promise.resolve(); let generation = 0;
  const locked = fn => { const next = queue.catch(() => {}).then(fn); queue = next; return next; };
  async function relativeURI(uri) {
    try {
      const relative = path.relative(getWorkspace(), fileURLToPath(uri)).replace(/\\/g, '/');
      await safePath(relative); return relative;
    } catch { return null; }
  }
  async function start(kind, root, state, documents) {
    const generationAtStart = generation;
    const pyright = path.join(home, 'node_modules/pyright/langserver.index.js');
    const clangd = path.join(home, 'language-runtime/clangd/bin/clangd.exe');
    await fs.access(kind === 'python' ? pyright : clangd).catch(() => { throw Error(kind === 'python' ? 'Python 语言服务未安装，请使用完整安装包或运行 npm ci。' : 'C/C++ 语言服务未安装，请使用完整安装包或运行 npm run prepare:languages。'); });
    let args = ['--stdio']; let executable = process.execPath;
    if (kind === 'python') args.unshift(pyright);
    else {
      executable = clangd;
      const database = path.join(dataDir, 'language', crypto.createHash('sha256').update(root).digest('hex').slice(0, 16));
      await fs.mkdir(database, { recursive: true });
      const names = [...new Set([...state.project.config.build.c, ...state.project.config.build.cpp, ...documents.filter(x => kindFor(x.path) === 'cpp').map(x => x.path)])];
      const commands = [];
      for (const name of names) {
        const file = await safePath(name); const c = /\.(c|h)$/i.test(name); const compiler = state.tools[c ? 'c' : 'cpp'];
        const includes = []; for (const dir of state.project.config.build.includeDirs) includes.push('-I', await safePath(dir));
        commands.push({ directory: root, file, arguments: [compiler.available ? compiler.path : c ? 'clang' : 'clang++', `-std=${c ? state.project.config.build.cStandard : state.project.config.build.cppStandard}`, ...includes, '-c', file] });
      }
      await fs.writeFile(path.join(database, 'compile_commands.json'), JSON.stringify(commands));
      args = [`--compile-commands-dir=${database}`, '--background-index', '--clang-tidy=false', '--log=error', '--enable-config=false'];
      // Restrict driver probing to the explicitly detected compiler paths.
      const drivers = [state.tools.c, state.tools.cpp].filter(x => x.available).map(x => x.path.replace(/\\/g, '/'));
      if (drivers.length) args.push(`--query-driver=${drivers.join(',')}`);
    }
    const session = { root, documents: new Map(), diagnostics: new Map(), sequence: 0 };
    const rpc = new RPC(executable, args, root, (method, params) => {
      if (method !== 'textDocument/publishDiagnostics' || getWorkspace() !== root || generation !== generationAtStart) return;
      // Pyright normalizes Windows drives to lower-case, percent-encoded URIs.
      // Match decoded paths rather than relying on wire URI spelling.
      const doc = session.documents.get(params.uri) || [...session.documents.values()].find(item => {
        try { const a = fileURLToPath(item.uri); const b = fileURLToPath(params.uri); return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; } catch { return false; }
      });
      if (!doc || params.version !== undefined && params.version !== doc.serviceVersion) return;
      const markers = (params.diagnostics || []).slice(0, 200).map(item => ({ line: item.range.start.line + 1, column: item.range.start.character + 1, endLine: item.range.end.line + 1, endColumn: item.range.end.character + 1, severity: item.severity === 1 ? 'error' : 'warning', message: String(item.message).slice(0, 3000), source: item.source || (kind === 'python' ? 'Pyright' : 'clangd') }));
      session.diagnostics.set(doc.path, markers); broadcast('language-diagnostics', { workspace: root, path: doc.path, version: doc.version, markers });
    });
    session.rpc = rpc;
    rpc.settings = kind === 'python' ? { python: { pythonPath: state.tools.python.available ? state.tools.python.path : undefined, analysis: { typeCheckingMode: 'basic', diagnosticMode: 'openFilesOnly', autoSearchPaths: true, useLibraryCodeForTypes: true } } } : {};
    try {
      await rpc.request('initialize', { processId: process.pid, rootUri: uriOf(root), workspaceFolders: [{ uri: uriOf(root), name: path.basename(root) }], capabilities: { textDocument: { completion: { completionItem: { snippetSupport: true } }, hover: { contentFormat: ['markdown', 'plaintext'] }, signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } }, publishDiagnostics: { versionSupport: true } }, workspace: { configuration: true } } });
      if (generation !== generationAtStart || getWorkspace() !== root) throw Error('工作区已切换。');
      rpc.notify('initialized', {}); rpc.notify('workspace/didChangeConfiguration', { settings: rpc.settings }); return session;
    } catch (error) { rpc.close(); throw error; }
  }
  async function sync(input) {
    return locked(async () => {
      const root = getWorkspace(); const state = await projectState();
      if (input.workspace && input.workspace !== root) throw Error('工作区已切换。');
      if (state.project.error) throw Error(state.project.error);
      const documents = [];
      if (!Array.isArray(input.files) || input.files.length > 64) throw Error('语言服务最多同步 64 个打开的文件。');
      for (const item of input.files) {
        if (!kindFor(item.path)) continue;
        const file = await safePath(item.path);
        if (typeof item.content !== 'string' || item.content.length > 2_000_000 || !Number.isInteger(item.version)) throw Error('语言服务文件内容无效。');
        documents.push({ ...item, uri: uriOf(file) });
      }
      const result = {};
      for (const kind of ['python', 'cpp']) {
        const group = documents.filter(item => kindFor(item.path) === kind);
        let session = sessions.get(kind);
        const signature = JSON.stringify({ root, project: state.project.config, tools: state.tools, paths: documents.map(x => x.path).sort() });
        if (session && (session.signature !== signature || session.rpc.dead)) { session.rpc.close(); sessions.delete(kind); session = null; }
        if (!group.length) { if (session) { session.rpc.close(); sessions.delete(kind); } continue; }
        try {
          if (!session) { session = await start(kind, root, state, documents); session.signature = signature; sessions.set(kind, session); }
          for (const item of group) {
            const old = session.documents.get(item.uri);
            if (old?.content === item.content) { old.version = item.version; continue; }
            const next = { ...item, serviceVersion: ++session.sequence }; session.documents.set(item.uri, next);
            if (!old) session.rpc.notify('textDocument/didOpen', { textDocument: { uri: item.uri, languageId: kind === 'python' ? 'python' : /\.(c|h)$/i.test(item.path) ? 'c' : 'cpp', version: next.serviceVersion, text: item.content } });
            else session.rpc.notify('textDocument/didChange', { textDocument: { uri: item.uri, version: next.serviceVersion }, contentChanges: [{ text: item.content }] });
          }
          result[kind] = { available: true, name: kind === 'python' ? 'Pyright' : 'clangd' };
        } catch (error) { result[kind] = { available: false, error: error.message }; }
      }
      return { services: result, diagnostics: [...sessions.values()].flatMap(session => [...session.diagnostics].map(([path, markers]) => ({ path, markers, version: [...session.documents.values()].find(doc => doc.path === path)?.version }))) };
    });
  }
  async function query(input, signal) {
    if (!allowedMethods.has(input.method)) throw Error('不支持这个语言查询。');
    if (!input.position || !Number.isInteger(input.position.line) || !Number.isInteger(input.position.character) || input.position.line < 0 || input.position.character < 0) throw Error('代码位置无效。');
    const file = await safePath(input.path); const session = sessions.get(kindFor(input.path)); const doc = session?.documents.get(uriOf(file));
    if (!doc || doc.version !== input.version || session.root !== getWorkspace()) return { stale: true, result: null };
    if (input.method === 'textDocument/rename' && (typeof input.newName !== 'string' || !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(input.newName))) throw Error('重命名名称无效。');
    const result = await session.rpc.request(input.method, { textDocument: { uri: doc.uri }, position: input.position, ...(input.method === 'textDocument/formatting' ? { options: { tabSize: 4, insertSpaces: true } } : {}), ...(input.method === 'textDocument/rename' ? { newName: input.newName } : {}) }, signal);
    if (session.documents.get(doc.uri)?.version !== input.version || session.root !== getWorkspace()) return { stale: true, result: null };
    if (input.method === 'textDocument/definition') {
      const locations = []; for (const item of Array.isArray(result) ? result : result ? [result] : []) {
        const relative = await relativeURI(item.uri || item.targetUri); if (relative !== null) locations.push({ path: relative, range: item.range || item.targetSelectionRange || item.targetRange });
      }
      return { result: locations };
    }
    return { result };
  }
  function reset() { generation++; for (const session of sessions.values()) session.rpc.close(); sessions.clear(); }
  return { sync, query, reset };
}
