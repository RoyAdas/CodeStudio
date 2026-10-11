import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { textFingerprint, isSensitiveMentorPath } from './mentor-shared.mjs';
const bad = (message, status = 400) => { const error = Error(message); error.status = status; throw error; };
export function createDebugger({ home, getWorkspace, safePath, projectState, broadcast, killChild, timeout }) {
  let job = null; let state = { phase: 'idle', frames: [], variables: [], output: '', breakpoints: {} };
  const snapshot = () => structuredClone(state);
  const publish = () => broadcast('debug', { workspace: getWorkspace(), state: snapshot() });
  async function stop() {
    const old = job; if (!old) return snapshot(); job = null; clearTimeout(old.timer);
    for (const pending of old.pending.values()) { clearTimeout(pending.timer); pending.reject(Error('调试已停止。')); } old.pending.clear();
    await killChild(old.child); state = { ...state, phase: 'finished', frames: [], variables: [] }; publish(); return snapshot();
  }
  function request(current, command, args = {}) {
    return new Promise((resolve, reject) => {
      if (job !== current) return reject(Error('调试已停止。'));
      const seq = ++current.seq; const timer = setTimeout(() => { current.pending.delete(seq); reject(Error(`调试请求超时：${command}`)); }, 15000);
      current.pending.set(seq, { resolve, reject, timer });
      const bytes = Buffer.from(JSON.stringify({ seq, type: 'request', command, arguments: args }));
      current.child.stdin.write(`Content-Length: ${bytes.length}\r\n\r\n`); current.child.stdin.write(bytes);
    });
  }
  async function refreshPaused(current, threadId) {
    const epoch = ++current.epoch;
    const stack = await request(current, 'stackTrace', { threadId, startFrame: 0, levels: 30 });
    const frames = [];
    for (const frame of stack.stackFrames || []) {
      if (!frame.source?.path) continue;
      const relative = path.relative(current.root, frame.source.path).replaceAll('\\', '/');
      try { await safePath(relative); } catch { continue; }
      frames.push({ id: frame.id, name: String(frame.name).slice(0, 200), path: relative, line: frame.line });
    }
    const variables = [];
    if (frames[0]) {
      const scopes = await request(current, 'scopes', { frameId: frames[0].id });
      for (const scope of (scopes.scopes || []).filter(s => !s.expensive).slice(0, 2)) {
        const values = await request(current, 'variables', { variablesReference: scope.variablesReference, start: 0, count: 100 });
        for (const value of (values.variables || []).slice(0, 100)) variables.push({ name: String(value.name).slice(0, 150), value: String(value.value).slice(0, 1000), type: String(value.type || '').slice(0, 100), reference: value.variablesReference || 0 });
      }
    }
    if (job !== current || epoch !== current.epoch || state.phase !== 'paused') return;
    state = { ...state, threadId, frames, variables }; publish();
  }
  function receive(current, message) {
    if (job !== current) return;
    if (message.type === 'response') {
      const pending = current.pending.get(message.request_seq); if (!pending) return;
      current.pending.delete(message.request_seq); clearTimeout(pending.timer);
      message.success ? pending.resolve(message.body || {}) : pending.reject(Error(String(message.message || '调试请求失败。').slice(0, 1000))); return;
    }
    if (message.type !== 'event') return;
    if (message.event === 'initialized') current.initialized();
    if (message.event === 'output' && !['telemetry'].includes(message.body?.category)) { state.output = (state.output + String(message.body?.output || '')).slice(-50000); publish(); }
    if (message.event === 'stopped') { state = { ...state, phase: 'paused', reason: message.body?.reason, frames: [], variables: [] }; publish(); void refreshPaused(current, message.body.threadId).catch(error => { if (job === current) { state.error = error.message; publish(); } }); }
    if (message.event === 'continued') { current.epoch++; state = { ...state, phase: 'running', frames: [], variables: [] }; publish(); }
    if (message.event === 'exited') { state.exitCode = message.body?.exitCode; publish(); }
    if (message.event === 'terminated') void stop();
  }
  async function breakpoints(input = {}) {
    const current = job; if (!current) bad('请先开始调试。');
    const file = await safePath(input.path); if (!file.endsWith('.py')) bad('断点仅支持 Python 文件。');
    if (!Array.isArray(input.lines) || input.lines.length > 100 || input.lines.some(line => !Number.isInteger(line) || line < 1 || line > 100000)) bad('断点行号无效。');
    const result = await request(current, 'setBreakpoints', { source: { path: file }, breakpoints: [...new Set(input.lines)].map(line => ({ line })), sourceModified: false });
    state.breakpoints = { ...state.breakpoints, [input.path]: (result.breakpoints || []).map(item => ({ line: item.line, verified: !!item.verified, message: item.message })) }; publish(); return snapshot();
  }
  async function start(input) {
    if (job) bad('已有调试会话，请先停止。', 409);
    const program = await safePath(input.path); if (path.extname(program).toLowerCase() !== '.py') bad('v0.4 调试支持 Python 文件。');
    const info = await projectState(); if (info.project.error) bad(info.project.error); if (!info.tools.python.available) bad('请先配置 Python。');
    const version = /Python\s+(\d+)\.(\d+)/.exec(info.tools.python.version);
    if (!version || Number(version[1]) !== 3 || Number(version[2]) < 10) bad('Python 调试需要 Python 3.10 或更新的 Python 3 版本。');
    const adapter = path.join(home, 'debug-runtime/lib/debugpy/adapter');
    await fs.access(path.join(adapter, '__main__.py')).catch(() => bad('调试组件缺失，请使用完整安装包或准备调试组件。'));
    const root = getWorkspace(); const sources = [];
    for (const relative of [...new Set([input.path, ...(Array.isArray(input.sourcePaths) ? input.sourcePaths.slice(0, 6) : [])])]) {
      if (isSensitiveMentorPath(relative)) continue;
      const file = await safePath(relative); const stat = await fs.stat(file); if (stat.size > 2 * 1024 * 1024 || !stat.isFile()) bad('调试源文件无效。');
      sources.push({ path: relative, sourceFingerprint: textFingerprint(await fs.readFile(file, 'utf8')) });
    }
    const child = spawn(info.tools.python.path, [adapter], { cwd: root, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYDEVD_USE_CYTHON: 'NO', PYDEVD_USE_FRAME_EVAL: 'NO' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const current = { id: crypto.randomUUID(), root, child, seq: 0, epoch: 0, pending: new Map(), buffer: Buffer.alloc(0), initialized: () => {}, timer: null }; job = current;
    state = { phase: 'starting', id: current.id, path: input.path, sources, frames: [], variables: [], output: '', breakpoints: {} }; publish();
    current.timer = setTimeout(() => { state.error = '调试达到时间上限，已停止。'; void stop(); }, timeout() * 1000);
    child.stdin.on('error', () => {});
    child.stderr.on('data', data => { if (job === current) { state.output = (state.output + data.toString('utf8')).slice(-50000); publish(); } });
    child.stdout.on('data', data => {
      current.buffer = Buffer.concat([current.buffer, data]);
      try {
        while (true) {
          const end = current.buffer.indexOf('\r\n\r\n'); if (end < 0) { if (current.buffer.length > 8192) throw Error('调试协议头过大。'); break; }
          const length = Number(/Content-Length:\s*(\d+)/i.exec(current.buffer.subarray(0, end).toString())?.[1]);
          if (!length || length > 4 * 1024 * 1024) throw Error('调试协议消息无效。');
          if (current.buffer.length < end + 4 + length) break;
          const message = JSON.parse(current.buffer.subarray(end + 4, end + 4 + length).toString('utf8')); current.buffer = current.buffer.subarray(end + 4 + length); receive(current, message);
        }
      } catch (error) { state.error = error.message; void stop(); }
    });
    child.once('error', error => { state.error = error.message; void stop(); });
    child.once('close', () => { if (job === current) void stop(); });
    try {
      await request(current, 'initialize', { clientID: 'codestudio', adapterID: 'python', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsRunInTerminalRequest: false });
      const initialized = new Promise(resolve => { current.initialized = resolve; });
      const launch = request(current, 'launch', { name: 'CodeStudio Python', type: 'python', request: 'launch', program, python: info.tools.python.path, cwd: root, args: input.args || [], console: 'internalConsole', redirectOutput: true, justMyCode: true, stopOnEntry: !!input.stopOnEntry, env: { PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYDEVD_USE_CYTHON: 'NO', PYDEVD_USE_FRAME_EVAL: 'NO' } });
      launch.catch(() => {});
      await Promise.race([initialized, launch.then(() => { throw Error('调试器未完成初始化。'); })]);
      for (const [file, lines] of Object.entries(input.breakpoints || {}).slice(0, 30)) await breakpoints({ path: file, lines });
      await request(current, 'configurationDone'); await launch;
      if (state.phase === 'starting') { state.phase = 'running'; publish(); }
      return snapshot();
    } catch (error) { if (job === current) { state.error = error.message; await stop(); } throw error; }
  }
  async function control(input) {
    const current = job; if (!current) bad('请先开始调试。');
    if (input.action === 'stop') return stop();
    if (!['continue', 'next', 'stepIn', 'stepOut', 'pause'].includes(input.action)) bad('不支持的调试操作。');
    if (input.action !== 'pause' && (state.phase !== 'paused' || !state.threadId)) bad('请等待调试器暂停并读取变量。');
    const threads = input.action === 'pause' ? await request(current, 'threads') : null;
    await request(current, input.action, { threadId: threads?.threads?.[0]?.id || state.threadId });
    return snapshot();
  }
  return { start, control, breakpoints, stop, snapshot, busy: () => !!job };
}
