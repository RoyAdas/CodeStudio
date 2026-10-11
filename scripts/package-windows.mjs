import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

if (process.platform !== 'win32') throw Error('Windows packaging requires Windows and PowerShell.');
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const runtime = JSON.parse((await fs.readFile(path.join(root, 'runtime-version.json'), 'utf8')).replace(/^\uFEFF/, ''));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || !/^\d+\.\d+\.\d+$/.test(runtime.nodeVersion)) throw Error('Invalid release version.');
const output = path.resolve(root, 'releases');
await fs.mkdir(output, { recursive: true });
await fs.access(path.join(root, 'dist/index.html')).catch(() => { throw Error('Run npm run build first.'); });
const archiveName = `node-v${runtime.nodeVersion}-win-x64.zip`;
const nodeArchive = process.env.STUDIO_NODE_ARCHIVE ? path.resolve(process.env.STUDIO_NODE_ARCHIVE) : path.join(output, archiveName);
try { await fs.access(nodeArchive); } catch {
  console.log(`Downloading official Node ${runtime.nodeVersion}...`);
  const response = await fetch(`https://nodejs.org/dist/v${runtime.nodeVersion}/${archiveName}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error(`Node download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(nodeArchive));
}
const runtimeHash = crypto.createHash('sha256').update(await fs.readFile(nodeArchive)).digest('hex');
if (runtimeHash !== runtime.windowsX64SHA256) throw Error('Node archive checksum mismatch.');
const staging = await fs.mkdtemp(path.join(output, '.pack-'));
const app = path.join(staging, 'CodeStudio');
const zipName = `CodeStudio-v${pkg.version}-windows-x64.zip`;
const zipPath = path.join(output, zipName);
async function powershell(script, environment) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: { ...process.env, ...environment }, stdio: 'inherit' });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(Error(`Packaging command exited ${code}`)));
  });
}
try {
  await fs.mkdir(path.join(app, 'runtime'), { recursive: true });
  // A fixed allowlist keeps local settings, private workspaces and logs out of releases.
  for (const name of ['dist', 'docs', 'licenses', 'examples', 'server.mjs', 'mentor.mjs', 'mentor-shared.mjs', 'project.mjs', 'Start.cmd', 'Stop.cmd', '启动工作台.cmd', '停止工作台.cmd', 'launch.ps1', 'README.md', 'README.en.md', 'CONTRIBUTING.md', 'LICENSE', 'CHANGELOG.md', 'runtime-version.json']) {
    await fs.cp(path.join(root, name), path.join(app, name), { recursive: true });
  }
  await fs.cp(path.join(root, 'examples'), path.join(app, 'workspace'), { recursive: true });
  const unpacked = path.join(staging, 'node');
  await powershell('$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:STUDIO_ARCHIVE, $env:STUDIO_UNPACK)', { STUDIO_ARCHIVE: nodeArchive, STUDIO_UNPACK: unpacked });
  await fs.copyFile(path.join(unpacked, `node-v${runtime.nodeVersion}-win-x64/node.exe`), path.join(app, 'runtime/node.exe'));
  await fs.writeFile(path.join(app, 'BUILD.json'), JSON.stringify({ name: 'CodeStudio', version: pkg.version, platform: 'windows-x64', nodeVersion: runtime.nodeVersion }, null, 2));
  if (path.dirname(path.resolve(zipPath)) !== output) throw Error('Release ZIP must remain in the release directory.');
  await fs.unlink(zipPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await powershell('$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:STUDIO_APP, $env:STUDIO_ZIP, [IO.Compression.CompressionLevel]::Optimal, $true)', { STUDIO_APP: app, STUDIO_ZIP: zipPath });
  const hash = crypto.createHash('sha256').update(await fs.readFile(zipPath)).digest('hex');
  await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), `${hash}  ${zipName}\n`);
  console.log(`Release ready: ${zipPath}\nSHA256: ${hash}`);
} finally {
  const resolved = path.resolve(staging);
  if (path.dirname(resolved) !== output || !path.basename(resolved).startsWith('.pack-')) throw Error('Refusing to remove a staging path outside the release directory.');
  await fs.rm(resolved, { recursive: true, force: true });
}
