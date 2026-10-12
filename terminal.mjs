import path from 'node:path';
import crypto from 'node:crypto';
export function createTerminalManager({ getWorkspace, broadcast }) {
  const sessions = new Map();
  const snapshot = () => [...sessions.values()].map(({ id, root, output, phase, code }) => ({ id, root, output, phase, code }));
  async function create() {
    if (sessions.size >= 6) throw Error('最多保留 6 个终端，请先关闭一个。');
    const pty = await import('node-pty');
    if (sessions.size >= 6) throw Error('最多保留 6 个终端，请先关闭一个。');
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const root = getWorkspace(); const id = crypto.randomUUID(); const session = { id, root, output: '', phase: 'running', code: null, process: null }; sessions.set(id, session);
    try {
      const process = pty.spawn(shell, ['-NoLogo', '-NoProfile'], { name: 'xterm-256color', cols: 90, rows: 20, cwd: root, env: { ...globalThis.process.env, TERM: 'xterm-256color' }, useConpty: true }); session.process = process;
      process.onData(text => { session.output = (session.output + text).slice(-100000); broadcast('terminal', { workspace: root, id, text }); });
      process.onExit(({ exitCode }) => { session.phase = 'finished'; session.code = exitCode; broadcast('terminal-exit', { workspace: root, id, code: exitCode }); });
      return { id, root, phase: session.phase };
    } catch (error) { sessions.delete(id); throw Error('无法创建本地终端：' + error.message); }
  }
  function input(data) { const session = sessions.get(data.id); if (!session || session.phase !== 'running' || session.root !== getWorkspace()) throw Error('终端已关闭或工作区已切换。'); if (typeof data.text !== 'string' || data.text.length > 16000) throw Error('终端输入无效。'); session.process.write(data.text); return { ok: true }; }
  function resize(data) { const session = sessions.get(data.id); if (session?.phase === 'running' && Number.isInteger(data.cols) && Number.isInteger(data.rows)) session.process.resize(Math.max(20, Math.min(240, data.cols)), Math.max(5, Math.min(100, data.rows))); return { ok: true }; }
  function close(id) { const session = sessions.get(id); if (session) { session.process?.kill(); sessions.delete(id); } return { ok: true }; }
  const closeAll = () => { for (const id of sessions.keys()) close(id); };
  return { create, input, resize, close, closeAll, snapshot };
}
