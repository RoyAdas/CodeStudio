import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
const pin = JSON.parse(await fs.readFile(path.join(root, 'language-runtime.json'), 'utf8'));
if (process.platform !== 'win32') throw Error('The bundled language runtime targets Windows x64.');
const directory = path.join(root, 'language-runtime'); await fs.mkdir(directory, { recursive: true });
const archive = process.env.STUDIO_CLANGD_ARCHIVE || path.join(directory, `clangd-windows-${pin.clangdVersion}.zip`);
try { await fs.access(archive); } catch {
  const response = await fetch(`https://github.com/clangd/clangd/releases/download/${pin.clangdVersion}/clangd-windows-${pin.clangdVersion}.zip`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error(`clangd download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
}
if (crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex') !== pin.windowsX64SHA256) throw Error('clangd checksum mismatch.');
const staging = await fs.mkdtemp(path.join(directory, '.unpack-'));
try {
  const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  await new Promise((resolve, reject) => {
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:STUDIO_ARCHIVE,$env:STUDIO_UNPACK)'], { windowsHide: true, stdio: 'inherit', env: { ...process.env, STUDIO_ARCHIVE: archive, STUDIO_UNPACK: staging } });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('clangd extraction failed')));
  });
  const unpacked = path.join(staging, `clangd_${pin.clangdVersion}`);
  await fs.access(path.join(unpacked, 'bin/clangd.exe'));
  await fs.cp(unpacked, path.join(directory, 'clangd'), { recursive: true });
  console.log(`Bundled clangd ${pin.clangdVersion} ready.`);
} finally {
  if (path.dirname(path.resolve(staging)) !== directory || !path.basename(staging).startsWith('.unpack-')) throw Error('Unsafe staging path.');
  await fs.rm(staging, { recursive: true, force: true });
}
