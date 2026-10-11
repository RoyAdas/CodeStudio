import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const pin = JSON.parse(await fs.readFile(path.join(root, 'debug-runtime.json'), 'utf8'));
const directory = path.join(root, 'debug-runtime');
await fs.mkdir(directory, { recursive: true });
const archive = process.env.STUDIO_DEBUGPY_ARCHIVE || path.join(directory, `debugpy-${pin.version}.whl`);
try { await fs.access(archive); } catch {
  const response = await fetch(pin.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error(`debugpy download failed: HTTP ${response.status}`);
  await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()));
}
if (crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex') !== pin.sha256) throw Error('debugpy checksum mismatch.');
const staging = await fs.mkdtemp(path.join(directory, '.unpack-'));
try {
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  await new Promise((resolve, reject) => {
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:STUDIO_ARCHIVE,$env:STUDIO_UNPACK)'], { windowsHide: true, stdio: 'inherit', env: { ...process.env, STUDIO_ARCHIVE: archive, STUDIO_UNPACK: staging } });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('debugpy extraction failed')));
  });
  await fs.access(path.join(staging, 'debugpy/adapter/__main__.py'));
  await fs.cp(staging, path.join(directory, 'lib'), { recursive: true });
  console.log(`Bundled debugpy ${pin.version} ready.`);
} finally {
  if (path.dirname(path.resolve(staging)) !== directory || !path.basename(staging).startsWith('.unpack-')) throw Error('Unsafe debugger staging path.');
  await fs.rm(staging, { recursive: true, force: true });
}
