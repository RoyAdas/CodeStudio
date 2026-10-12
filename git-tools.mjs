import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isSensitiveMentorPath } from './mentor-shared.mjs';
const bad = (message, status = 400) => { const error = Error(message); error.status = status; throw error; };
export function createGitTools({ getWorkspace, safePath }) {
  let busy = false;
  async function run(args, input = '', allowFail = false) {
    return new Promise((resolve, reject) => {
      const root = getWorkspace(); const child = spawn('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args], { cwd: root, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; let settled = false; const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { child.kill(); finish(Error('Git 操作超时。')); }, 60000);
      child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 2_000_000) { child.kill(); finish(Error('Git 输出过大。')); } });
      child.stderr.on('data', chunk => { if (output.length < 2_000_000) output += chunk.toString(); });
      child.once('error', () => finish(Error('未找到 Git，请安装 Git for Windows。'))); child.once('close', code => finish(code && !allowFail ? Error(output.slice(-2000).replace(/https?:\/\/[^\s/]+:[^\s@]+@/g, 'https://[hidden]@')) : null, { code, output }));
      child.stdin.on('error', () => {}); child.stdin.end(input);
    });
  }
  async function repository() {
    const info = await run(['rev-parse', '--show-toplevel'], '', true);
    if (info.code) return false;
    if (path.resolve(info.output.trim()).toLowerCase() !== getWorkspace().toLowerCase()) bad('请直接打开 Git 仓库根目录，避免操作上级仓库。'); return true;
  }
  async function state() {
    try {
      if (!await repository()) return { available: true, repository: false, files: [], commits: [], busy };
      const raw = (await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).output; const entries = raw.split('\0'); const files = [];
      for (let i = 0; i < entries.length; i++) { const entry = entries[i]; if (entry.length < 4) continue; const status = entry.slice(0, 2); const relative = entry.slice(3); if (/[RC]/.test(status)) i++; files.push({ path: relative, index: status[0], worktree: status[1], sensitive: isSensitiveMentorPath(relative) }); }
      const branch = (await run(['branch', '--show-current'])).output.trim();
      const log = await run(['log', '-20', '--format=%H%x00%s%x00%aI'], '', true);
      const commits = log.code ? [] : log.output.trim().split('\n').filter(Boolean).map(line => { const [id, subject, date] = line.split('\0'); return { id, subject, date }; });
      const remote = await run(['config', '--get', 'remote.origin.url'], '', true);
      return { available: true, repository: true, branch, files, commits, remote: remote.output.trim().replace(/https?:\/\/[^\s/]+:[^\s@]+@/g, 'https://[hidden]@'), busy };
    } catch (error) { return { available: false, repository: false, files: [], commits: [], error: error.message, busy }; }
  }
  async function operation(input) {
    if (busy) bad('Git 操作正在进行。', 409); busy = true;
    try {
      if (input.action === 'init') { try { await fs.access(path.join(getWorkspace(), '.git')); } catch (error) { if (error.code !== 'ENOENT') throw error; await run(['init']); } return { ...await state(), busy: false }; }
      if (!await repository()) bad('请先初始化或打开 Git 仓库。');
      if (['stage', 'unstage'].includes(input.action)) {
        if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 100) bad('请选择 1–100 个文件。');
        const paths = [...new Set(input.paths)];
        for (const relative of paths) { if (relative === '.' || isSensitiveMentorPath(relative)) bad('不能批量暂存敏感路径。'); await safePath(relative, true); }
        if (input.action === 'stage') await run(['--literal-pathspecs', 'add', '--', ...paths]);
        else if ((await run(['rev-parse', '--verify', 'HEAD'], '', true)).code) await run(['--literal-pathspecs', 'rm', '--cached', '--', ...paths]);
        else await run(['--literal-pathspecs', 'restore', '--staged', '--', ...paths]);
      } else if (input.action === 'commit') {
        if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 5000) bad('请输入提交说明。');
        const sensitive = (await run(['diff', '--cached', '--name-only', '-z'])).output.split('\0').filter(Boolean).some(isSensitiveMentorPath);
        if (sensitive) bad('暂存区包含敏感文件，请在终端检查并移除后再提交。');
        await run(['commit', '-F', '-'], input.message);
      } else if (input.action === 'identity') {
        if (typeof input.name !== 'string' || typeof input.email !== 'string' || !input.name.trim() || !/^[^\s@]+@[^\s@]+$/.test(input.email) || input.name.length > 100 || input.email.length > 200) bad('请填写提交者姓名和邮箱。');
        await run(['config', '--local', 'user.name', input.name.trim()]); await run(['config', '--local', 'user.email', input.email.trim()]);
      } else if (['push', 'pull'].includes(input.action)) {
        const remote = (await run(['config', '--get', 'remote.origin.url'], '', true)).output.trim();
        if (!remote || /https?:\/\/[^\s/]+:[^\s@]+@/.test(remote)) bad('请在本机 Git 配置 origin 和凭据；地址不能包含密码。');
        if (!/^(https:\/\/|ssh:\/\/|git@)/.test(remote)) bad('远程操作仅支持 HTTPS 或 SSH origin。');
        const branch = (await run(['branch', '--show-current'])).output.trim(); if (!branch || branch.startsWith('-')) bad('当前没有可推送的分支。');
        await run(input.action === 'push' ? ['push', '-u', 'origin', branch] : ['pull', '--ff-only', 'origin', branch]);
      } else bad('不支持此 Git 操作。');
      return { ...await state(), busy: false };
    } finally { busy = false; }
  }
  async function diff(input) {
    if (!await repository()) bad('请先打开 Git 仓库。'); await safePath(input.path, true); if (isSensitiveMentorPath(input.path)) bad('敏感文件不发送到差异面板。');
    const args = input.staged ? ['diff', '--cached'] : ['diff']; const output = (await run(['--literal-pathspecs', ...args, '--no-ext-diff', '--', input.path])).output;
    return { text: output || '没有可显示的差异。' };
  }
  return { state, operation, diff, busy: () => busy };
}
