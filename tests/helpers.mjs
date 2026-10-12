import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function eventually(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Condition was not satisfied within ${timeout} ms.`);
}

export async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

export async function closeServer(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

export async function createFixture({ files = {}, settings = {}, requireDist = false, requireLanguages = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-studio-test-'));
  try {
    for (const name of ['server.mjs', 'mentor.mjs', 'mentor-shared.mjs', 'project.mjs', 'ai-stream.mjs', 'backup.mjs', 'language-service.mjs', 'debugger.mjs', 'testing.mjs', 'ai-changes.mjs', 'test-runner.py', 'python-tools.py', 'workspace-tools.mjs', 'git-tools.mjs', 'terminal.mjs', 'editor-tools.mjs', 'learning.mjs', 'templates.mjs', 'updates.mjs']) {
      await fs.copyFile(path.join(projectRoot, name), path.join(root, name));
    }
    await fs.mkdir(path.join(root, 'node_modules'));
    for (const name of ['node-pty', 'prettier']) await fs.symlink(path.join(projectRoot, 'node_modules', name), path.join(root, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(path.join(projectRoot, 'python-runtime'), path.join(root, 'python-runtime'), process.platform === 'win32' ? 'junction' : 'dir');
    if (requireLanguages) {
      await fs.symlink(path.join(projectRoot, 'node_modules/pyright'), path.join(root, 'node_modules/pyright'), process.platform === 'win32' ? 'junction' : 'dir');
      await fs.symlink(path.join(projectRoot, 'language-runtime'), path.join(root, 'language-runtime'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (requireLanguages) await fs.symlink(path.join(projectRoot, 'debug-runtime'), path.join(root, 'debug-runtime'), process.platform === 'win32' ? 'junction' : 'dir');
    const dist = path.join(projectRoot, 'dist');
    try {
      await fs.access(path.join(dist, 'index.html'));
      await fs.cp(dist, path.join(root, 'dist'), { recursive: true });
    } catch (error) {
      if (error.code !== 'ENOENT' || requireDist) {
        if (requireDist && error.code === 'ENOENT') throw new Error('Build the app first with npm run build before running browser tests.');
        throw error;
      }
      await fs.mkdir(path.join(root, 'dist'));
      await fs.writeFile(path.join(root, 'dist/index.html'), '<!doctype html><html><head><meta name="studio-token" content="__STUDIO_TOKEN__"></head><body>Test fixture</body></html>');
    }
    await fs.mkdir(path.join(root, 'data'));
    await fs.mkdir(path.join(root, 'workspace'));
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, 'workspace', name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    await fs.writeFile(path.join(root, 'data/settings.json'), JSON.stringify({
      workspace: path.join(root, 'workspace'), provider: 'custom', protocol: 'chat',
      baseUrl: '', model: 'test-model', encryptedKey: '', anonymous: true,
      timeout: 120, tools: {}, ...settings,
    }));
    let child;
    let serviceLog = '';
    let base;
    let token;
    async function start() {
      // The server accepts a start port and may choose the next free port. Read
      // its own state file so parallel tests never connect to another instance.
      const reservation = http.createServer();
      const reservedBase = await listen(reservation);
      const startPort = new URL(reservedBase).port;
      await closeServer(reservation);
      child = spawn(process.execPath, ['server.mjs'], {
        cwd: root, env: { ...process.env, STUDIO_PORT: startPort },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stderr.on('data', data => { serviceLog += data.toString(); });
      child.on('error', error => { serviceLog += error.message; });
      await eventually(async () => {
        if (child.exitCode !== null) throw new Error(`Test server exited: ${serviceLog}`);
        try {
          const state = JSON.parse(await fs.readFile(path.join(root, 'data/running.json'), 'utf8'));
          base = `http://127.0.0.1:${state.port}`;
          const html = await fetch(base, { signal: AbortSignal.timeout(1000) }).then(response => response.text());
          token = html.match(/name="studio-token" content="([^"]+)"/)?.[1];
          return !!token;
        } catch { return false; }
      });
      return base;
    }
    async function call(route, data, options = {}) {
      const { headers = {}, ...requestOptions } = options;
      const response = await fetch(`${base}/api/${route}`, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { 'X-Studio-Token': token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(15000), ...requestOptions,
      });
      return { status: response.status, value: await response.json() };
    }
    async function cleanup() {
      if (child && child.exitCode === null) {
        const closed = new Promise(resolve => child.once('close', resolve));
        child.kill();
        let killTimer;
        await Promise.race([closed, new Promise(resolve => { killTimer = setTimeout(resolve, 3000); })]);
        clearTimeout(killTimer);
        if (child.exitCode === null) { child.kill('SIGKILL'); await closed; }
      }
      // This path is always the freshly created, absolute temporary fixture.
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    return { root, start, call, cleanup, get base() { return base; }, get token() { return token; }, get log() { return serviceLog; } };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}
