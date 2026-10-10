import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { createMentorController } from './mentor.mjs';
import { textFingerprint } from './mentor-shared.mjs';

const HOME = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HOME, 'data');
const DIST = path.join(HOME, 'dist');
const DEFAULT_WORKSPACE = path.join(HOME, 'workspace');
const STATE_FILE = path.join(DATA, 'running.json');
const CONFIG_FILE = path.join(DATA, 'settings.json');
const INSTANCE = crypto.createHash('sha256').update(HOME.toLowerCase()).digest('hex').slice(0, 20);
const SESSION = crypto.randomBytes(32).toString('hex');
const CONTROL = crypto.randomBytes(32).toString('hex');
const peers = new Set();
let currentRun = null;
let server;
let port;
let toolsCache;
await fs.mkdir(DATA, { recursive: true });
await fs.mkdir(DEFAULT_WORKSPACE, { recursive: true });

if (process.argv.includes('--stop')) {
  try {
    const state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    const health = await fetch(`http://127.0.0.1:${state.port}/api/health`, { signal: AbortSignal.timeout(1500) }).then(r => r.json());
    if (health.instance !== INSTANCE) throw Error('工作台身份不匹配');
    const result = await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, { method: 'POST', headers: { 'X-Studio-Token': state.control }, signal: AbortSignal.timeout(5000) });
    if (!result.ok) throw Error('无法停止工作台');
    console.log('工作台已停止。');
  } catch { console.log('工作台当前未运行，或正在关闭。'); }
  process.exit(0);
}

const defaults = { workspace: DEFAULT_WORKSPACE, provider: 'custom', protocol: 'chat', baseUrl: '', model: '', encryptedKey: '', tools: { python: '', c: '', cpp: '' }, timeout: 120, anonymous: false };
let config;
try { config = { ...defaults, ...JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8')) }; }
catch (e) { if (e.code !== 'ENOENT') throw Error('设置文件损坏，请将 data/settings.json 改名后重试。'); config = defaults; }
let ROOT;
try { ROOT = await fs.realpath(config.workspace); if (!(await fs.stat(ROOT)).isDirectory()) throw Error(); }
catch { ROOT = await fs.realpath(DEFAULT_WORKSPACE); }

function cleanError(value, secret = '') {
  let message = String(value?.message || value || '未知错误');
  if (secret) message = message.split(secret).join('[已隐藏]');
  return message.replace(/\bsk-[\w-]{8,}/g, '[已隐藏]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').slice(0, 1000);
}
function fail(message, status = 400) { const e = Error(message); e.status = status; throw e; }
async function persist() {
  const temp = `${CONFIG_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  await fs.rename(temp, CONFIG_FILE);
}
function publicConfig() { const { encryptedKey, ...rest } = config; return { ...rest, workspace: ROOT, hasKey: !!encryptedKey }; }
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) fail('内容太大（最多 2 MB）。', 413); chunks.push(chunk); }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text || '{}'); } catch { fail('请求格式不正确。'); }
}
function inside(candidate) { const rel = path.relative(ROOT, candidate); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); }
async function safePath(relative, allowNew = false) {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)) fail('请使用工作区内的相对路径。');
  const candidate = path.resolve(ROOT, relative);
  if (!inside(candidate)) fail('不能访问工作区之外的文件。', 403);
  try {
    const real = await fs.realpath(candidate);
    if (!inside(real)) fail('文件链接指向工作区之外。', 403);
    return candidate;
  } catch (e) {
    if (!allowNew || e.code !== 'ENOENT') throw e;
    const parent = await fs.realpath(path.dirname(candidate));
    if (!inside(parent)) fail('目录链接指向工作区之外。', 403);
    return candidate;
  }
}
const ignored = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.code-studio-build', '.DS_Store']);
async function tree() {
  let count = 0; let truncated = false;
  async function walk(dir, prefix = '', depth = 0) {
    if (depth > 10) { truncated = true; return []; }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const result = [];
    for (const entry of entries) {
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      if (++count > 4000) { truncated = true; break; }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) result.push({ name: entry.name, path: relative, type: 'directory', children: await walk(path.join(dir, entry.name), relative, depth + 1) });
      else if (entry.isFile()) result.push({ name: entry.name, path: relative, type: 'file' });
    }
    return result;
  }
  return { entries: await walk(ROOT), truncated };
}
async function findExecutable(names, candidates = []) {
  const explicit = names.length === 0;
  const searchPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const paths = [...new Set([...names.flatMap(name => searchPath.map(dir => path.join(dir.replace(/^"|"$/g, ''), name))), ...candidates].filter(Boolean))];
  const deadline = Date.now() + 6000;
  let attempts = 0; let lastPath = '';
  for (const candidate of paths.slice(0, 256)) {
    // Windows App Execution Aliases can open the Store instead of an interpreter.
    if (!explicit && names.includes('python.exe') && /[\\/]Microsoft[\\/]WindowsApps(?:[\\/]|$)/i.test(candidate)) continue;
    if (!explicit && (attempts >= 3 || Date.now() >= deadline)) break;
    try { if (!(await fs.stat(candidate)).isFile()) continue; } catch { continue; }
    attempts++; lastPath = candidate;
    try {
      const result = await capture(candidate, ['--version'], '', explicit ? 3000 : Math.max(1, Math.min(3000, deadline - Date.now())));
      const version = String(result).trim().split(/\r?\n/)[0];
      if (!version) throw Error('工具没有返回版本信息');
      return { path: candidate, available: true, version };
    } catch {
      if (explicit) return { path: candidate, available: false, version: '无法启动；请在设置中检查指定路径' };
    }
  }
  return { path: explicit ? candidates[0] || '' : lastPath, available: false, version: explicit ? '指定路径不存在或不是文件；请在设置中检查路径' : attempts ? '检测到工具但无法启动；请在设置中配置有效路径' : '未检测到；请先安装或配置路径' };
}
async function capture(executable, args, input = '', timeout = 4000) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(Error('操作超时。')); }, timeout);
    child.stdout.on('data', d => { if (!settled) stdout += d.toString(); });
    child.stderr.on('data', d => { if (!settled) stderr += d.toString(); });
    child.once('error', e => finish(e));
    child.once('close', code => finish(code === 0 ? null : Error(stderr || `程序退出：${code}`), stdout || stderr));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
async function detectTools() {
  if (toolsCache) return toolsCache;
  const definitions = {
    python: { names: ['python.exe', 'python3.exe'], candidates: ['C:\\Python314\\python.exe', 'C:\\Python313\\python.exe', ...['Python314', 'Python313', 'Python312'].map(version => path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', version, 'python.exe'))] },
    c: { names: ['gcc.exe', 'clang.exe'], candidates: ['C:\\msys64\\ucrt64\\bin\\gcc.exe', 'C:\\msys64\\mingw64\\bin\\gcc.exe', 'C:\\Program Files\\LLVM\\bin\\clang.exe'] },
    cpp: { names: ['g++.exe', 'clang++.exe'], candidates: ['C:\\msys64\\ucrt64\\bin\\g++.exe', 'C:\\msys64\\mingw64\\bin\\g++.exe', 'C:\\Program Files\\LLVM\\bin\\clang++.exe'] },
  };
  const entries = await Promise.all(Object.entries(definitions).map(async ([name, definition]) => [name, await findExecutable(config.tools?.[name] ? [] : definition.names, config.tools?.[name] ? [config.tools[name]] : definition.candidates)]));
  const output = { ...Object.fromEntries(entries), javascript: { path: process.execPath, available: true, version: process.version } };
  toolsCache = output; return output;
}
async function protectKey(value, decrypt = false) {
  if (process.platform !== 'win32') fail('此安装包使用 Windows 密钥保护，请在 Windows 上启动。');
  const script = decrypt
    ? "Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"
    : "Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))";
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { return String(await capture(shell, ['-NoProfile', '-NonInteractive', '-Command', script], value, 10000)).trim(); }
  catch { fail('本机密钥保护失败，设置未保存。请确认 Windows 用户配置可用。'); }
}
function emit(type, payload = {}) {
  const event = { type, ...payload };
  const wire = `data: ${JSON.stringify(event)}\n\n`;
  for (const peer of peers) peer.write(wire);
  if (currentRun && type === 'output') {
    currentRun.output += payload.text;
    if (currentRun.output.length > 1_000_000 && !currentRun.stopping) { currentRun.stopping = true; emit('output', { text: '\n输出超过 1 MB，已停止。\n', channel: 'system' }); void killChild(currentRun.child); }
  }
}
async function killChild(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { await capture(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], '', 6000); } catch { child.kill(); }
  } else child.kill('SIGTERM');
}
function diagnostics(text, relative) {
  const markers = [];
  const regex = /^(.+?):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.+)$/gm;
  for (const match of text.matchAll(regex)) {
    if (path.resolve(match[1]).toLowerCase() !== path.resolve(ROOT, relative).toLowerCase()) continue;
    markers.push({ line: Number(match[2]), column: Number(match[3]), message: match[5], severity: match[4].includes('error') ? 'error' : 'warning' });
  }
  const py = /File "[^"]+", line (\d+)[\s\S]*?\n(?:[\w.]+Error|[\w.]+Exception): ([^\n]+)/.exec(text);
  if (py) markers.push({ line: Number(py[1]), column: 1, message: py[2], severity: 'error' });
  return markers;
}
function parseArguments(value = '') {
  if (typeof value !== 'string' || value.length > 4000) fail('运行参数过长。');
  const result = []; let word = ''; let quote = ''; let started = false;
  for (const ch of value) {
    if (quote) { if (ch === quote) quote = ''; else word += ch; started = true; }
    else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (/\s/.test(ch)) { if (started) { result.push(word); word = ''; started = false; } }
    else { word += ch; started = true; }
  }
  if (quote) fail('运行参数中的引号未配对。');
  if (started) result.push(word);
  return result;
}
async function spawnRun(run, executable, args, cwd, phase) {
  return await new Promise(resolve => {
    const child = spawn(executable, args, { cwd, windowsHide: true, env: { ...process.env, PATH: `${path.dirname(executable)}${path.delimiter}${run.extraPath || ''}${path.delimiter}${process.env.PATH || ''}`, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    run.child = child; run.phase = phase;
    const timeout = phase === 'compile' ? 30000 : Math.max(10, Math.min(600, Number(config.timeout) || 120)) * 1000;
    const timer = setTimeout(() => { run.stopping = true; emit('output', { text: `\n已达到 ${timeout / 1000} 秒限制，停止程序。\n`, channel: 'system' }); void killChild(child); }, timeout);
    const out = new StringDecoder('utf8'); const err = new StringDecoder('utf8');
    let captured = ''; let settled = false;
    const finish = code => { if (settled) return; settled = true; clearTimeout(timer); const tail = out.end() + err.end(); if (tail) emit('output', { text: tail, channel: 'stdout' }); resolve({ code, captured }); };
    child.stdout.on('data', data => { const text = out.write(data); if (captured.length < 100000) captured += text; emit('output', { text, channel: 'stdout' }); });
    child.stderr.on('data', data => { const text = err.write(data); if (captured.length < 100000) captured += text; emit('output', { text, channel: 'stderr' }); });
    child.on('error', e => { emit('output', { text: `无法启动：${cleanError(e)}\n`, channel: 'stderr' }); finish(-1); });
    child.on('close', finish); child.stdin.on('error', () => {});
    if (run.stopping) void killChild(child);
    if (phase === 'compile') child.stdin.end();
    else if (run.initialInput) child.stdin.write(run.initialInput);
    if (phase === 'run') emit('phase', { phase: 'run', id: run.id });
  });
}
async function execute(run, file, relative, language, args) {
  let code = -1;
  try {
    const available = await detectTools();
    const tool = available[language];
    if (!tool?.available) fail('运行环境未检测到，请在设置中填写解释器或 GCC / Clang 路径。');
    run.extraPath = path.dirname(tool.path);
    const cwd = path.dirname(file);
    if (language === 'c' || language === 'cpp') {
      const build = path.join(DATA, 'build'); await fs.mkdir(build, { recursive: true });
      const target = path.join(build, `${run.id}.exe`);
      emit('output', { text: `编译 ${relative} …\n`, channel: 'system' });
      const compilation = await spawnRun(run, tool.path, [file, '-o', target, language === 'c' ? '-std=c11' : '-std=c++17', '-Wall', '-Wextra', '-g', '-fdiagnostics-color=never'], cwd, 'compile');
      emit('diagnostics', { path: relative, markers: diagnostics(compilation.captured, relative) });
      if (compilation.code !== 0 || run.stopping) code = compilation.code;
      else { emit('output', { text: '编译成功，开始运行。\n', channel: 'system' }); code = (await spawnRun(run, target, args, cwd, 'run')).code; }
      try { await fs.unlink(target); } catch {}
    } else {
      emit('output', { text: `运行 ${relative} …\n`, channel: 'system' });
      const result = await spawnRun(run, tool.path, language === 'python' ? ['-u', file, ...args] : [file, ...args], cwd, 'run');
      code = result.code; emit('diagnostics', { path: relative, markers: diagnostics(result.captured, relative) });
    }
  } catch (e) { emit('output', { text: `${cleanError(e)}\n`, channel: 'stderr' }); }
  finally {
    run.child = null; run.code = code; run.phase = 'finished';
    emit('finish', { id: run.id, code, stopped: run.stopping, duration: Date.now() - run.started });
  }
}
function endpoint(base, protocol) {
  let url; try { url = new URL(base.trim()); } catch { fail('请填写完整的 API 地址，例如 https://api.deepseek.com。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) fail('API 地址必须是 HTTP 或 HTTPS，且不包含账号、查询参数或片段。');
  let pathname = url.pathname.replace(/\/+$/, '');
  const suffix = protocol === 'anthropic' ? '/messages' : protocol === 'responses' ? '/responses' : '/chat/completions';
  if (!pathname.endsWith(suffix)) pathname += protocol === 'anthropic' && !pathname ? `/v1${suffix}` : suffix;
  url.pathname = pathname; return url.toString();
}
async function aiRequest(data, overrides = {}) {
  const apiConfig = { ...config };
  if (!apiConfig.baseUrl || !apiConfig.model) fail('请先在 AI 设置中填写 API 地址和模型。');
  if (!apiConfig.encryptedKey && !apiConfig.anonymous) fail('请在 AI 设置中填写密钥。');
  const secret = apiConfig.encryptedKey ? await protectKey(apiConfig.encryptedKey, true) : '';
  const url = endpoint(apiConfig.baseUrl, apiConfig.protocol);
  const test = data.kind === 'test'; const complete = data.kind === 'complete';
  let system = '你是中文编程导师，帮助有基础的学习者通过项目练习。每次给一个小任务，先给提示，再检查代码。先阅读当前文件和错误输出。普通对话避免直接交付整份答案；用户明确要求补全、解释、修复或完整示例时按要求帮助。说明与当前代码有关的具体问题，不声称运行了没有运行的代码。用简洁中文和带语言名的代码块。';
  let messages;
  if (test) { system = 'Reply briefly.'; messages = [{ role: 'user', content: 'Reply with OK.' }]; }
  else if (complete) {
    system = 'You complete code at the cursor. Return ONLY the exact code to insert. No markdown, explanations, or repeated existing prefix/suffix. Preserve indentation. Complete a small useful section.';
    messages = [{ role: 'user', content: `Language: ${String(data.language).slice(0, 30)}\nFile: ${String(data.path).slice(0, 300)}\n<before_cursor>\n${String(data.prefix || '').slice(-12000)}\n</before_cursor>\n<after_cursor>\n${String(data.suffix || '').slice(0, 5000)}\n</after_cursor>` }];
  } else {
    system += `\n当前文件：${String(data.path || '').slice(0, 300)}\n语言：${String(data.language || '').slice(0, 30)}\n代码：\n${String(data.code || '').slice(0, 30000)}\n选中代码：\n${String(data.selection || '').slice(0, 8000)}\n实际终端输出：\n${String(data.output || '').slice(-10000)}`;
    if (data.taskContext && typeof data.taskContext === 'object') system += `\n学习者当前任务（保持一步一步提示）：${JSON.stringify(data.taskContext).slice(0, 6000)}`;
    if (!Array.isArray(data.messages) || !data.messages.length) fail('请先输入问题。');
    messages = data.messages.slice(-16).filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content.slice(0, 10000) }));
    if (!messages.length) fail('没有有效问题。');
  }
  if (overrides.system) system = overrides.system;
  if (overrides.messages) messages = overrides.messages;
  const maxTokens = overrides.maxTokens || (test ? 64 : complete ? 1024 : 3072);
  const headers = { 'Content-Type': 'application/json' };
  let request;
  if (apiConfig.protocol === 'anthropic') {
    if (secret) headers['x-api-key'] = secret;
    headers['anthropic-version'] = '2023-06-01';
    request = { model: apiConfig.model, max_tokens: maxTokens, system, messages, stream: false };
  } else if (apiConfig.protocol === 'responses') {
    if (secret) headers.Authorization = `Bearer ${secret}`;
    request = { model: apiConfig.model, instructions: system, input: messages, max_output_tokens: maxTokens, stream: false };
  } else {
    if (secret) headers.Authorization = `Bearer ${secret}`;
    request = { model: apiConfig.model, messages: [{ role: 'system', content: system }, ...messages], max_tokens: maxTokens, stream: false };
    if (apiConfig.provider === 'deepseek') request.thinking = { type: 'disabled' };
  }
  let response;
  try { response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request), redirect: 'manual', signal: overrides.signal ? AbortSignal.any([AbortSignal.timeout(90000), overrides.signal]) : AbortSignal.timeout(90000) }); }
  catch (e) { if (overrides.signal?.aborted) throw e; fail(`无法连接 API：${cleanError(e, secret)}。请检查地址、网络与服务可用性。`, 502); }
  const raw = await response.text();
  let result; try { result = JSON.parse(raw); } catch { fail(`API 返回了非 JSON 内容（HTTP ${response.status}）。请检查地址是否为 API 接口。`, 502); }
  if (!response.ok) {
    const detail = cleanError(result.error?.message || result.message || `HTTP ${response.status}`, secret);
    const help = response.status === 401 || response.status === 403 ? '请检查密钥及该模型的访问权限。' : response.status === 429 ? '服务限流或额度不足，请稍后重试并检查账户。' : response.status >= 300 && response.status < 400 ? '接口发生重定向，请填写最终 API 地址。' : '请检查接口协议、模型名称和服务状态。';
    fail(`API ${response.status}：${detail} ${help}`, 502);
  }
  let content = apiConfig.protocol === 'anthropic' ? (result.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n')
    : apiConfig.protocol === 'responses' ? (result.output_text || (result.output || []).flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('\n'))
    : result.choices?.[0]?.message?.content;
  if (Array.isArray(content)) content = content.map(x => x.text || '').join('');
  if (typeof content !== 'string' || !content.trim()) fail('API 没有返回可用文本。请检查模型是否支持所选协议，或改用非推理模型。', 502);
  if (complete) content = content.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '');
  return { text: content, model: apiConfig.model, usage: result.usage || null };
}
const mentor = createMentorController({ dataDir: DATA, getWorkspace: () => ROOT, broadcast: emit, askAI: ({ system, messages, signal, maxTokens }) => aiRequest({ kind: 'mentor', messages }, { system, messages, signal, maxTokens }) });
async function shutdown() {
  mentor.abortAll();
  if (currentRun?.child) { currentRun.stopping = true; await killChild(currentRun.child); }
  try { const s = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); if (s.pid === process.pid) await fs.unlink(STATE_FILE); } catch {}
  for (const peer of peers) peer.end();
  server.close(); setTimeout(() => process.exit(0), 300).unref();
}

server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) fail('无效的本机地址。', 403);
    if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) fail('请从工作台页面操作。', 403);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (url.pathname === '/api/health') return json(res, { name: 'CodeStudio', instance: INSTANCE, port });
    if (url.pathname === '/api/shutdown' && req.method === 'POST' && req.headers['x-studio-token'] === CONTROL) { json(res, { ok: true }); void shutdown(); return; }
    if (url.pathname.startsWith('/api/')) {
      const token = req.headers['x-studio-token'] || (url.pathname === '/api/events' ? url.searchParams.get('token') : '');
      if (token !== SESSION) fail('会话已更新，请刷新页面。', 403);
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /api/state') return json(res, { settings: publicConfig(), tools: await detectTools(), tree: await tree(), run: currentRun ? { id: currentRun.id, phase: currentRun.phase, path: currentRun.path, sourceFingerprint: currentRun.sourceFingerprint, output: currentRun.output, code: currentRun.code, stopped: currentRun.stopping } : null });
      if (route === 'GET /api/mentor') return json(res, await mentor.handle('state'));
      if (req.method === 'POST' && url.pathname.startsWith('/api/mentor/')) {
        const data = await body(req); const controller = new AbortController();
        const disconnect = () => { if (!res.writableEnded) controller.abort(); }; res.on('close', disconnect);
        try { return json(res, await mentor.handle(url.pathname.slice('/api/mentor/'.length), data, { signal: controller.signal })); }
        finally { res.off('close', disconnect); }
      }
      if (route === 'GET /api/files') {
        const file = await safePath(url.searchParams.get('path') || ''); const stat = await fs.stat(file);
        if (!stat.isFile()) fail('请选择文件。'); if (stat.size > 2 * 1024 * 1024) fail('文件超过 2 MB，暂不支持编辑。');
        const content = await fs.readFile(file, 'utf8'); if (content.includes('\0')) fail('该文件是二进制文件，无法作为文本编辑。');
        return json(res, { path: url.searchParams.get('path'), content });
      }
      if (route === 'POST /api/files') {
        const data = await body(req); const file = await safePath(data.path, true);
        if (typeof data.content !== 'string') fail('文件内容无效。');
        const temp = `${file}.studio-${crypto.randomBytes(5).toString('hex')}.tmp`;
        await fs.writeFile(temp, data.content, { flag: 'wx' }); await fs.rename(temp, file);
        return json(res, { ok: true });
      }
      if (route === 'POST /api/new') {
        const data = await body(req); const file = await safePath(data.path, true);
        if (file === ROOT) fail('请输入文件或目录名称。');
        if (data.type === 'directory') await fs.mkdir(file); else await fs.writeFile(file, '', { flag: 'wx' });
        return json(res, { ok: true, tree: await tree() });
      }
      if (route === 'POST /api/pick-folder') {
        const script = 'Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description="选择编程工作区"; if($d.ShowDialog() -eq "OK"){[Console]::Out.Write($d.SelectedPath)}';
        const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const selected = String(await capture(shell, ['-NoProfile', '-STA', '-Command', script], '', 180000)).trim();
        return json(res, { path: selected });
      }
      if (route === 'POST /api/workspace') {
        if (currentRun && currentRun.phase !== 'finished') fail('请先停止正在运行的程序。', 409);
        const data = await body(req); const root = await fs.realpath(data.path);
        if (!(await fs.stat(root)).isDirectory()) fail('请选择有效的文件夹。');
        mentor.abortAll(); ROOT = root; config.workspace = root; await persist(); currentRun = null;
        return json(res, { settings: publicConfig(), tree: await tree() });
      }
      if (route === 'POST /api/settings') {
        const data = await body(req); const next = { ...config };
        if (typeof data.baseUrl === 'string' && data.baseUrl.trim() !== config.baseUrl) next.encryptedKey = '';
        if (typeof data.baseUrl === 'string' && data.baseUrl) endpoint(data.baseUrl, data.protocol || config.protocol);
        for (const field of ['provider', 'baseUrl', 'model']) if (typeof data[field] === 'string') next[field] = data[field].trim().slice(0, 1000);
        if (['chat', 'responses', 'anthropic'].includes(data.protocol)) next.protocol = data.protocol;
        if (typeof data.anonymous === 'boolean') next.anonymous = data.anonymous;
        if (data.timeout !== undefined) next.timeout = Math.max(10, Math.min(600, Number(data.timeout) || 120));
        if (data.tools) next.tools = Object.fromEntries(['python', 'c', 'cpp'].map(x => [x, String(data.tools[x] || '').trim()]));
        if (data.clearKey) next.encryptedKey = '';
        if (typeof data.key === 'string' && data.key.trim()) next.encryptedKey = await protectKey(data.key.trim());
        config = next; await persist(); toolsCache = null;
        return json(res, { settings: publicConfig(), tools: await detectTools() });
      }
      if (route === 'POST /api/ai') return json(res, await aiRequest(await body(req)));
      if (route === 'POST /api/run') {
        if (currentRun && currentRun.phase !== 'finished') fail('已有程序正在运行，请先停止。', 409);
        const data = await body(req); const file = await safePath(data.path);
        if (!(await fs.stat(file)).isFile()) fail('请选择代码文件。');
        const extension = path.extname(file).toLowerCase();
        const language = ({ '.py': 'python', '.c': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.js': 'javascript', '.mjs': 'javascript' })[extension];
        if (!language) fail('当前文件不能运行。支持 .py、.c、.cpp、.cc、.cxx、.js、.mjs。');
        const args = parseArguments(data.args);
        const run = { id: crypto.randomBytes(8).toString('hex'), path: data.path, sourceFingerprint: textFingerprint(await fs.readFile(file, 'utf8')), output: '', started: Date.now(), phase: language === 'c' || language === 'cpp' ? 'compile' : 'run', child: null, stopping: false, initialInput: String(data.input || '').slice(0, 100000) };
        currentRun = run; emit('start', { id: run.id, path: data.path, sourceFingerprint: run.sourceFingerprint, phase: run.phase }); json(res, { id: run.id });
        void execute(run, file, data.path, language, args); return;
      }
      if (route === 'POST /api/input') {
        if (!currentRun?.child || currentRun.phase !== 'run') fail('程序当前没有等待输入的运行进程。');
        const data = await body(req); const text = String(data.text || '').slice(0, 100000);
        if (data.eof) currentRun.child.stdin.end(); else currentRun.child.stdin.write(text);
        if (text) emit('output', { text, channel: 'input' }); return json(res, { ok: true });
      }
      if (route === 'POST /api/stop') {
        if (currentRun && currentRun.phase !== 'finished') { currentRun.stopping = true; await killChild(currentRun.child); }
        return json(res, { ok: true });
      }
      if (route === 'GET /api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': connected\n\n'); peers.add(res);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        req.on('close', () => { peers.delete(res); clearInterval(heartbeat); }); return;
      }
      fail('接口不存在。', 404);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') fail('方法不支持。', 405);
    let relative; try { relative = decodeURIComponent(url.pathname); } catch { fail('路径无效。'); }
    const requested = path.resolve(DIST, `.${relative === '/' ? '/index.html' : relative}`);
    const rel = path.relative(DIST, requested); if (rel.startsWith('..') || path.isAbsolute(rel)) fail('路径无效。', 403);
    let bytes = await fs.readFile(requested);
    const extension = path.extname(requested);
    if (extension === '.html') bytes = Buffer.from(bytes.toString().replace('__STUDIO_TOKEN__', SESSION));
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': types[extension] || 'application/octet-stream', 'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=86400', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'" });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch (e) {
    if (res.headersSent) { res.end(); return; }
    const error = e.code === 'ENOENT' ? '文件或目录不存在，请刷新文件列表。' : e.code === 'EEXIST' ? '名称已存在，请换一个名称。' : e.code === 'EACCES' || e.code === 'EPERM' ? '没有访问该文件的权限，或文件正在被占用。' : cleanError(e);
    json(res, { error }, e.status || (e.code === 'ENOENT' ? 404 : 400));
  }
});
for (let candidate = Number(process.env.STUDIO_PORT) || 8765; candidate < (Number(process.env.STUDIO_PORT) || 8765) + 20; candidate++) {
  try {
    await new Promise((resolve, reject) => { const onError = e => { server.off('listening', onListen); reject(e); }; const onListen = () => { server.off('error', onError); resolve(); }; server.once('error', onError); server.once('listening', onListen); server.listen(candidate, '127.0.0.1'); });
    port = candidate; break;
  } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
}
if (!port) throw Error('本机端口被占用，请关闭已有工作台后重试。');
await fs.writeFile(STATE_FILE, JSON.stringify({ pid: process.pid, port, instance: INSTANCE, control: CONTROL }), { mode: 0o600 });
console.log(`Code Studio 已启动：http://127.0.0.1:${port}`);
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
