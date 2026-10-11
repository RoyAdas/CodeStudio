import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('SKIP Windows release package smoke test: Windows and PowerShell are required.');
  process.exit(0);
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const zipPath = path.join(projectRoot, 'releases', `CodeStudio-v${packageJson.version}-windows-x64.zip`);
const expectedRuntime = JSON.parse((await fs.readFile(path.join(projectRoot, 'runtime-version.json'), 'utf8')).replace(/^\uFEFF/, ''));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const prefix = 'code-studio-package-test-';
const temporaryParent = await fs.realpath(os.tmpdir());
const temporaryRoot = await fs.mkdtemp(path.join(temporaryParent, prefix));
const unpackRoot = path.join(temporaryRoot, '中文 安装验收');
const appRoot = path.join(unpackRoot, 'CodeStudio');
const stateFile = path.join(appRoot, 'data/running.json');
const checks = [];
const skips = [];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let reservation;
let started = false;
let stopped = false;
let baseUrl;
let instance;
let sessionToken;
let primaryError;

function check(name) { checks.push(name); console.log(`PASS ${name}`); }

async function runCommand(executable, args, { cwd = appRoot, env = {}, timeout = 60000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let settled = false; let drainTimer;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(drainTimer);
      // A launcher can exit while its background service retains pipe handles.
      // The foreground process exit code remains the command result.
      child.stdout.destroy(); child.stderr.destroy();
      error ? reject(error) : resolve(output);
    };
    const timer = setTimeout(() => { child.kill(); finish(Error('Package test command timed out.')); }, timeout);
    const append = data => { output = (output + data.toString()).slice(-20000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.once('error', error => finish(error));
    child.once('exit', code => {
      if (settled) return;
      clearTimeout(timer);
      drainTimer = setTimeout(() => finish(code === 0 ? null : Error(`Package test command exited ${code}: ${output}`)), 200);
    });
    child.once('close', code => finish(code === 0 ? null : Error(`Package test command exited ${code}: ${output}`)));
  });
}

async function eventually(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw Error('Package test condition timed out.');
}

async function listFiles(root, relative = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    assert.equal(entry.isSymbolicLink(), false, `Unexpected symbolic link in package: ${name}`);
    if (entry.isDirectory()) {
      assert.equal(/^(data|backups|node_modules|\.git)$/i.test(entry.name), false, `Private or development directory in package: ${name}`);
      result.push(...await listFiles(root, name));
    }
    else { assert.ok(entry.isFile(), `Unexpected package entry: ${name}`); result.push(name); }
  }
  return result.sort();
}

function assertOwnedDirectory() {
  const resolved = path.resolve(temporaryRoot);
  assert.equal(path.dirname(resolved).toLowerCase(), temporaryParent.toLowerCase(), 'Temporary package fixture must remain directly under the system temporary directory.');
  assert.ok(path.basename(resolved).startsWith(prefix), 'Temporary package fixture must use its dedicated prefix.');
  const relative = path.relative(resolved, path.resolve(appRoot));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Package commands must remain inside the freshly created fixture.');
}

async function readRunningState() {
  return JSON.parse(await fs.readFile(stateFile, 'utf8'));
}

async function healthIsRunning() {
  let address = baseUrl;
  if (!address) {
    try { address = `http://127.0.0.1:${(await readRunningState()).port}`; } catch { return false; }
  }
  try {
    const response = await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(1200) });
    const health = await response.json();
    return response.ok && health.name === 'CodeStudio' && health.instance === instance;
  } catch { return false; }
}

async function call(route, data, timeout = 15000) {
  const response = await fetch(`${baseUrl}/api/${route}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'X-Studio-Token': sessionToken, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(timeout),
  });
  const value = await response.json();
  assert.equal(response.status, 200, `Local API ${route} failed: ${value.error || response.status}`);
  return value;
}

async function stopOwnedPackage() {
  assertOwnedDirectory();
  // Invoke only this fixture's Stop.cmd. Its instance check protects other apps.
  for (let attempt = 0; attempt < 3; attempt++) {
    await runCommand(powershell, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; & $env:STUDIO_PACKAGE_STOP; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"], {
      env: { STUDIO_PACKAGE_STOP: path.join(appRoot, 'Stop.cmd') }, timeout: 15000,
    });
    try {
      await eventually(async () => !await healthIsRunning(), 10000);
      stopped = true;
      return;
    } catch { if (attempt === 2) throw Error('Fixture service did not stop using its own Stop.cmd; keeping its temporary files for diagnosis.'); }
  }
}

try {
  assertOwnedDirectory();
  await fs.access(zipPath);
  await fs.mkdir(unpackRoot);
  await runCommand(powershell, ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:STUDIO_PACKAGE_ZIP, $env:STUDIO_PACKAGE_UNPACK)'], {
    cwd: temporaryRoot, env: { STUDIO_PACKAGE_ZIP: zipPath, STUDIO_PACKAGE_UNPACK: unpackRoot },
  });
  assert.deepEqual(await fs.readdir(unpackRoot), ['CodeStudio']);
  const rootEntries = await fs.readdir(appRoot);
  assert.equal(rootEntries.includes('data'), false, 'Release must not ship local data.');
  assert.equal(rootEntries.includes('node_modules'), false);
  assert.equal(rootEntries.includes('.git'), false);
  const packagedFiles = await listFiles(appRoot);
  assert.equal(packagedFiles.some(name => /(^|\/)(data|backups|node_modules|\.git)(\/|$)/i.test(name)), false, 'Release must exclude personal data, backups and development dependencies.');
  assert.equal(packagedFiles.some(name => /(^|\/)(settings\.json|running\.json|mentor-sessions\.json)$|\.log$/i.test(name)), false, 'Release must exclude settings and logs.');
  for (const name of ['Start.cmd', 'Stop.cmd', '启动工作台.cmd', '停止工作台.cmd', 'launch.ps1', 'dist/index.html', 'README.md', 'README.en.md', 'LICENSE', 'licenses/Node-LICENSE.txt']) assert.ok(packagedFiles.includes(name), `Required package file is missing: ${name}`);
  const exampleFiles = await listFiles(path.join(projectRoot, 'examples'));
  const workspaceFiles = await listFiles(path.join(appRoot, 'workspace'));
  assert.deepEqual(workspaceFiles, exampleFiles, 'Packaged workspace must contain only public examples.');
  for (const name of exampleFiles) assert.deepEqual(await fs.readFile(path.join(appRoot, 'workspace', name)), await fs.readFile(path.join(projectRoot, 'examples', name)), `Packaged example differs: ${name}`);
  check('Clean ZIP contains complete launch files and only public workspace examples');

  const runtime = JSON.parse((await fs.readFile(path.join(appRoot, 'runtime-version.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.deepEqual(runtime, expectedRuntime);
  const bundledVersion = (await runCommand(path.join(appRoot, 'runtime/node.exe'), ['--version'])).trim();
  assert.equal(bundledVersion, `v${runtime.nodeVersion}`);
  const build = JSON.parse(await fs.readFile(path.join(appRoot, 'BUILD.json'), 'utf8'));
  assert.equal(build.version, packageJson.version);
  assert.equal(build.nodeVersion, runtime.nodeVersion);
  assert.equal(build.platform, 'windows-x64');
  check(`Bundled Node ${runtime.nodeVersion} and release ${packageJson.version} match build metadata`);

  for (let attempt = 0; attempt < 10; attempt++) {
    reservation = http.createServer((_request, response) => { response.writeHead(503); response.end('package-test-port-blocker'); });
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    if (reservation.address().port < 65516) break;
    await new Promise(resolve => reservation.close(resolve));
  }
  const occupiedPort = reservation.address().port;
  assert.ok(occupiedPort < 65516, 'Reserved port must leave room for the app fallback range.');
  instance = crypto.createHash('sha256').update(appRoot.toLowerCase()).digest('hex').slice(0, 20);
  const launchArguments = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(appRoot, 'launch.ps1'), '-NoBrowser'];
  const launchOptions = { env: { STUDIO_PORT: String(occupiedPort) }, timeout: 30000 };
  started = true;
  await runCommand(powershell, launchArguments, launchOptions);
  const running = await readRunningState();
  assert.equal(running.instance, instance);
  assert.ok(running.port > occupiedPort && running.port < occupiedPort + 20);
  assert.ok(await healthIsRunning());
  baseUrl = `http://127.0.0.1:${running.port}`;
  check('One-click launcher starts from a Chinese path with spaces and falls back from an occupied port');

  await runCommand(powershell, launchArguments, launchOptions);
  const secondLaunch = await readRunningState();
  assert.equal(secondLaunch.pid, running.pid);
  assert.equal(secondLaunch.port, running.port);
  assert.equal(secondLaunch.instance, running.instance);
  check('Repeated launch reuses the same service instance');

  const htmlResponse = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
  assert.equal(htmlResponse.status, 200);
  const html = await htmlResponse.text();
  sessionToken = html.match(/name="studio-token" content="([^"]+)"/)?.[1];
  assert.ok(sessionToken, 'Local editor page must contain its session token.');
  assert.equal((await fetch(`${baseUrl}/api/state`, { signal: AbortSignal.timeout(5000) })).status, 403);
  const state = await call('state');
  assert.equal(state.settings.hasKey, false);
  assert.equal(state.settings.baseUrl, '');
  assert.equal(state.settings.model, '');
  assert.equal(state.settings.anonymous, false);
  assert.equal('encryptedKey' in state.settings, false);
  assert.equal(path.resolve(state.settings.workspace).toLowerCase(), path.resolve(appRoot, 'workspace').toLowerCase());
  check('Editor opens locally with a protected API and empty AI credentials');

  for (const [tool, file] of [['python', 'main.py'], ['c', 'hello.c'], ['cpp', 'hello.cpp']]) {
    assert.equal(typeof state.tools[tool]?.available, 'boolean');
    assert.ok(state.tools[tool]?.version, `Missing tool diagnostic for ${tool}`);
    if (!state.tools[tool].available) { skips.push(tool); console.log(`SKIP ${tool} example: runtime tool is unavailable; configuring a path is required.`); continue; }
    const result = await call('run', { path: file, args: '' });
    let run;
    await eventually(async () => { run = (await call('state')).run; return run?.id === result.id && run.phase === 'finished'; }, 40000);
    assert.equal(run.code, 0, `${tool} packaged example failed: ${run.output}`);
    assert.match(run.output, /Hello, CodeStudio!/);
    assert.match(run.output, /Sum:\s*15/);
    check(`${tool} public example executes using the downloaded package`);
  }

  for (const [tool, folder, file, expected] of [['c', 'c-project', 'main.c', 'C project total: 42'], ['cpp', 'cpp-project', 'main.cpp', 'C++ project total: 42']]) {
    if (!state.tools[tool].available) continue;
    const switched = await call('workspace', { path: path.join(appRoot, 'workspace', folder) });
    assert.equal(switched.project.exists, true);
    assert.equal(switched.project.config.build[tool].length, 2);
    const result = await call('run', { path: file }); let run;
    await eventually(async () => { run = (await call('state')).run; return run?.id === result.id && run.phase === 'finished'; }, 40000);
    assert.equal(run.code, 0, run.output); assert.ok(run.output.includes(expected), run.output);
    const remaining = await fs.readdir(path.join(appRoot, 'workspace', folder));
    assert.equal(remaining.some(name => name.startsWith('.studio-build-')), false);
    check(`${tool} packaged multi-file example builds from its own project configuration`);
  }
  await call('workspace', { path: path.join(appRoot, 'workspace') });
  if (state.tools.python.available) {
    await call('project', { python: { mode: 'venv', venv: '.venv-package' } });
    const environment = await call('project/venv', {}, 190000);
    assert.equal(environment.tools.python.environment, 'venv'); assert.equal(environment.tools.python.available, true);
    await call('new', { path: 'check_env.py', type: 'file' });
    await call('files', { path: 'check_env.py', content: 'import sys\nprint("PACKAGED_ENV", sys.prefix != sys.base_prefix)\n' });
    const result = await call('run', { path: 'check_env.py' }); let run;
    await eventually(async () => { run = (await call('state')).run; return run?.id === result.id && run.phase === 'finished'; }, 40000);
    assert.equal(run.code, 0, run.output); assert.match(run.output, /PACKAGED_ENV True/);
    check('Packaged application creates and runs a Python environment under Chinese installation paths');
  }

  await stopOwnedPackage();
  await eventually(async () => { try { await fs.access(stateFile); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } });
  const blocker = await fetch(`http://127.0.0.1:${occupiedPort}`, { signal: AbortSignal.timeout(1500) }).then(response => response.text());
  assert.equal(blocker, 'package-test-port-blocker');
  check('Stop.cmd shuts down only its own extracted instance and preserves the unrelated port blocker');
} catch (error) {
  primaryError = error;
  // Only this clean fixture's generated startup log is read; credentials remain
  // empty, and keeping its error makes CI startup failures actionable.
  if (started) {
    try {
      const startupError = (await fs.readFile(path.join(appRoot, 'data/server-error.log'), 'utf8')).trim();
      if (startupError) primaryError = new Error(`${error.message}\nPackage startup log: ${startupError.slice(-8000)}`, { cause: error });
    } catch { /* Startup may fail before creating a log. */ }
  }
} finally {
  const cleanupErrors = [];
  if (started && !stopped) {
    try { await stopOwnedPackage(); } catch (error) { cleanupErrors.push(error); }
  }
  if (reservation) {
    try { reservation.closeAllConnections(); await new Promise(resolve => reservation.close(resolve)); } catch (error) { cleanupErrors.push(error); }
  }
  if (!started || stopped) {
    try {
      assertOwnedDirectory();
      const realRoot = await fs.realpath(temporaryRoot);
      assert.equal(path.dirname(realRoot).toLowerCase(), temporaryParent.toLowerCase());
      assert.ok(path.basename(realRoot).startsWith(prefix));
      await fs.rm(realRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) { cleanupErrors.push(error); }
  }
  if (primaryError || cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors].filter(Boolean), 'Windows release package smoke test failed.', { cause: primaryError || cleanupErrors[0] });
}

console.log(`Package smoke test passed: ${checks.length} checks; ${skips.length} unavailable language tools skipped.`);
