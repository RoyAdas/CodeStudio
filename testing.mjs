import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { textFingerprint, isSensitiveMentorPath } from './mentor-shared.mjs';
const bad = (message, status = 400) => { const error = Error(message); error.status = status; throw error; };
export function createTesting({ home, dataDir, getWorkspace, safePath, projectState, broadcast, killChild, timeout }) {
  let job = null; let state = { phase: 'idle', cases: [], output: '' };
  const snapshot = () => structuredClone(state);
  const publish = () => broadcast('tests', { workspace: getWorkspace(), state: snapshot() });
  async function sources() {
    const result = []; let count = 0;
    const info = await projectState(); const ignored = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.code-studio-build', info.project.config.python.venv]);
    async function walk(dir, prefix = '', depth = 0) {
      if (depth > 12) bad('测试工作区层级过深。');
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink() || ignored.has(entry.name) || isSensitiveMentorPath(relative)) continue;
        if (++count > 10000) bad('测试工作区文件过多，请打开较小的项目。');
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative, depth + 1);
        else if (entry.isFile() && /\.(py|json|txt|csv)$/i.test(entry.name)) {
          const file = await safePath(relative); const stat = await fs.stat(file);
          if (stat.size > 2 * 1024 * 1024 || result.length >= 1000) bad('测试输入过大，请缩小工作区。');
          result.push({ path: relative, sourceFingerprint: textFingerprint(await fs.readFile(file, 'utf8')) });
        }
      }
    }
    await walk(getWorkspace()); return result.sort((a, b) => a.path.localeCompare(b.path));
  }
  async function evidence(id) {
    if (state.id !== id || state.phase !== 'finished') return null;
    let current; try { current = await sources(); } catch { return { ...snapshot(), matchesDisk: false }; }
    return { ...snapshot(), matchesDisk: JSON.stringify(current) === JSON.stringify(state.sources) };
  }
  async function stop() { if (job) { job.stopping = true; await killChild(job.child); } return snapshot(); }
  async function start(input = {}) {
    if (job) bad('测试正在运行。', 409);
    const info = await projectState(); if (info.project.error) bad(info.project.error); if (!info.tools.python.available) bad('请先配置 Python。');
    const directory = input.directory || '.'; const startDir = await safePath(directory);
    if (!(await fs.stat(startDir)).isDirectory()) bad('请选择测试目录。');
    const pattern = input.pattern || 'test*.py'; if (typeof pattern !== 'string' || pattern.length > 100 || !/^[\w.*?-]+\.py$/.test(pattern)) bad('测试文件模式无效。');
    const current = { id: crypto.randomUUID(), root: getWorkspace(), child: null, stopping: false }; job = current;
    try {
      const before = await sources(); const outputDir = path.join(dataDir, 'testing'); await fs.mkdir(outputDir, { recursive: true });
      const resultFile = path.join(outputDir, `${current.id}.json`);
      const framework = input.framework === 'pytest' ? 'pytest' : 'unittest';
      const selected = input.failedOnly ? (state.cases || []).filter(item => ['failed', 'error', 'unexpectedSuccess'].includes(item.status)).map(item => item.id) : [];
      if (input.failedOnly && !selected.length) bad('没有可重跑的失败用例。');
      if (framework === 'pytest') for (const id of selected) { if (id.startsWith('-')) bad('测试编号无效。'); await safePath(id.split('::')[0]); }
      state = { id: current.id, phase: 'running', framework, directory, pattern, sources: before, cases: [], output: '', started: Date.now() }; publish();
      const child = spawn(info.tools.python.path, [path.join(home, 'test-runner.py'), current.root, startDir, pattern, resultFile, framework, input.coverage ? '1' : '0', JSON.stringify(selected)], { cwd: current.root, windowsHide: true, env: { ...process.env, PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] }); current.child = child;
      const limit = setTimeout(() => { current.stopping = true; state.error = '测试达到时间上限，已停止。'; void killChild(child); }, timeout() * 1000);
      const append = chunk => { state.output = (state.output + chunk.toString('utf8')).slice(-50000); publish(); };
      child.stdout.on('data', append); child.stderr.on('data', append);
      void new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).then(async code => {
        if (job !== current) return;
        let report; try { const stat = await fs.stat(resultFile); if (stat.size > 2 * 1024 * 1024) throw Error('测试结果过大。'); report = JSON.parse(await fs.readFile(resultFile, 'utf8')); } catch (error) { state.error ||= current.stopping ? '测试已停止。' : '未收到完整测试结果。'; }
        const cases = Array.isArray(report?.cases) ? report.cases.slice(0, 1000).map(item => ({ id: String(item.id).slice(0, 300), status: ['passed', 'failed', 'error', 'skipped', 'expectedFailure', 'unexpectedSuccess'].includes(item.status) ? item.status : 'error', detail: String(item.detail || '').slice(-8000) })) : [];
        state = { ...state, phase: 'finished', exitCode: code, cases, coverage: report?.coverage || null, stopped: current.stopping, duration: Date.now() - state.started, passed: code === 0 && !current.stopping && !state.error && cases.some(item => item.status === 'passed') && !cases.some(item => ['failed', 'error', 'unexpectedSuccess'].includes(item.status)) };
      }).catch(error => { state = { ...state, phase: 'finished', passed: false, error: error.message }; }).finally(async () => { clearTimeout(limit); if (job === current) { job = null; publish(); } await fs.unlink(resultFile).catch(() => {}); });
      return snapshot();
    } catch (error) { job = null; throw error; }
  }
  return { start, stop, snapshot, evidence, busy: () => !!job, reset() { if (job) bad('请先停止测试。', 409); state = { phase: 'idle', cases: [], output: '' }; } };
}
