import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const pin = JSON.parse(await fs.readFile(path.join(root, 'python-runtime.json'), 'utf8'));
const directory = path.join(root, 'python-runtime'); await fs.mkdir(directory, { recursive: true });
for (const wheel of pin.wheels) {
  const archive = path.join(process.env.STUDIO_PYTHON_WHEELS || directory, wheel.file);
  try { await fs.access(archive); } catch {
    const response = await fetch(wheel.url, { signal: AbortSignal.timeout(120000) }); if (!response.ok) throw Error(`Python component HTTP ${response.status}: ${wheel.name}`);
    await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()));
  }
  if (crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex') !== wheel.sha256) throw Error(`Python component checksum mismatch: ${wheel.name}`);
  const staging = await fs.mkdtemp(path.join(directory, '.unpack-'));
  try {
    const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    await new Promise((resolve, reject) => { const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:STUDIO_ARCHIVE,$env:STUDIO_UNPACK)'], { windowsHide: true, stdio: 'inherit', env: { ...process.env, STUDIO_ARCHIVE: archive, STUDIO_UNPACK: staging } }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('Python component extraction failed'))); });
    await fs.cp(staging, path.join(directory, 'lib'), { recursive: true });
  } finally {
    if (path.dirname(path.resolve(staging)) !== directory || !path.basename(staging).startsWith('.unpack-')) throw Error('Unsafe Python staging path.');
    await fs.rm(staging, { recursive: true, force: true });
  }
}
console.log(`Prepared ${pin.wheels.length} pinned Python packages.`);
