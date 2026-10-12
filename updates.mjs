import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
export function createUpdates({ home, version, dataDir, backups, fetcher = fetch }) {
  const repository = 'RoyAdas/CodeStudio'; let versions = path.join(home, 'versions'); let manifest = path.join(dataDir, 'installed-versions.json'); let family = home; let release = null; let busy = false;
  async function location() { try { const record = JSON.parse(await fs.readFile(path.join(dataDir, 'install-family.json'), 'utf8')); if (record.root !== home && !(path.dirname(home).toLowerCase() === path.join(record.root, 'versions').toLowerCase() && /^\d+\.\d+\.\d+$/.test(path.basename(home)))) throw Error('Invalid install family'); family = record.root; versions = path.join(family, 'versions'); manifest = path.join(family, 'data/installed-versions.json'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  const allowed = item => /^\d+\.\d+\.\d+$/.test(item.version) && typeof item.path === 'string' && (item.registered === true || path.dirname(item.path) === versions || item.path === family);
  async function check() {
    const response = await fetcher(`https://api.github.com/repos/${repository}/releases/latest`, { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'CodeStudio' }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error(`更新检查失败：HTTP ${response.status}`); const raw = await response.text(); if (raw.length > 500000) throw Error('更新信息过大。'); const item = JSON.parse(raw);
    if (!/^v\d+\.\d+\.\d+$/.test(item.tag_name) || item.draft || item.prerelease) throw Error('更新版本信息无效。');
    const name = `CodeStudio-${item.tag_name}-windows-x64.zip`; const asset = item.assets?.find(value => value.name === name);
    if (!asset || asset.browser_download_url !== `https://github.com/${repository}/releases/download/${item.tag_name}/${name}` || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '') || asset.size > 250 * 1024 * 1024) throw Error('更新包缺少可信地址或校验值。');
    release = { version: item.tag_name.slice(1), name, url: asset.browser_download_url, digest: asset.digest.slice(7), size: asset.size, notes: String(item.body || '').slice(0, 30000), page: item.html_url };
    return { current: version, release: { ...release }, newer: release.version.localeCompare(version, undefined, { numeric: true }) > 0 };
  }
  async function list() { await location(); let items; try { items = JSON.parse(await fs.readFile(manifest, 'utf8')); } catch { items = []; } let originalVersion; if (family !== home) { try { originalVersion = JSON.parse(await fs.readFile(path.join(family, 'BUILD.json'), 'utf8')).version; } catch {} } const all = [{ version, path: home, current: true }, ...(originalVersion ? [{ version: originalVersion, path: family, current: false }] : []), ...items.filter(allowed).map(item => ({ ...item, current: item.path === home }))]; return all.filter((item, index) => all.findIndex(other => other.path === item.path) === index); }
  async function download() {
    if (!release) throw Error('请先检查更新。'); if (busy) throw Error('正在下载更新。'); if (release.version === version) throw Error('当前已是该版本。');
    busy = true; let staging;
    try {
      await location(); await fs.mkdir(versions, { recursive: true }); const target = path.join(versions, release.version);
      try { await fs.access(target); throw Error('该版本文件夹已存在，请从版本列表启动。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      staging = await fs.mkdtemp(path.join(versions, '.install-')); const zip = path.join(staging, 'package.zip');
      const response = await fetcher(release.url, { signal: AbortSignal.timeout(180000) }); if (!response.ok) throw Error(`更新下载失败：HTTP ${response.status}`);
      const reader = response.body.getReader(); const parts = []; let size = 0;
      while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 250 * 1024 * 1024) { await reader.cancel(); throw Error('更新包过大。'); } parts.push(Buffer.from(item.value)); }
      const bytes = Buffer.concat(parts); if (size !== release.size || crypto.createHash('sha256').update(bytes).digest('hex') !== release.digest) throw Error('更新包校验失败，未安装。'); await fs.writeFile(zip, bytes);
      const unpack = path.join(staging, 'unpack');
      const script = '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:STUDIO_ZIP); try { $total=0; foreach($e in $z.Entries){$total+=$e.Length; $n=$e.FullName.Replace([char]92,[char]47); $p=[IO.Path]::GetFullPath([IO.Path]::Combine($env:STUDIO_UNPACK,$n)); if(!$p.StartsWith($env:STUDIO_UNPACK+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or $total -gt 1500000000 -or !$n.StartsWith("CodeStudio/")){throw "Unsafe update archive"} } } finally {$z.Dispose()}; [IO.Compression.ZipFile]::ExtractToDirectory($env:STUDIO_ZIP,$env:STUDIO_UNPACK)';
      await new Promise((resolve, reject) => { const child = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: { ...process.env, STUDIO_ZIP: zip, STUDIO_UNPACK: unpack }, stdio: ['ignore', 'ignore', 'pipe'] }); let error = ''; child.stderr.on('data', chunk => { error += chunk; }); child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(error.slice(-1000) || '更新解压失败。'))); });
      const app = path.join(unpack, 'CodeStudio'); const metadata = JSON.parse(await fs.readFile(path.join(app, 'BUILD.json'), 'utf8')); if (metadata.name !== 'CodeStudio' || metadata.version !== release.version || metadata.platform !== 'windows-x64') throw Error('更新构建信息不匹配。'); await fs.access(path.join(app, 'Start.cmd'));
      await backups.capture('before-update'); await fs.mkdir(path.join(app, 'data'), { recursive: true });
      for (const name of ['settings.json', 'mentor-sessions.json', 'learning.json']) { try { const file = path.join(dataDir, name); if ((await fs.lstat(file)).isSymbolicLink()) throw Error('设置不能是文件链接。'); await fs.copyFile(file, path.join(app, 'data', name)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      try { await fs.cp(path.join(dataDir, 'file-history'), path.join(app, 'data/file-history'), { recursive: true, filter: async file => !(await fs.lstat(file)).isSymbolicLink() }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.writeFile(path.join(app, 'data/install-family.json'), JSON.stringify({ root: family }));
      await fs.rename(app, target); const current = (await list()).filter(item => !item.current); current.push({ version: release.version, path: target, installedAt: new Date().toISOString(), digest: release.digest }); await fs.writeFile(manifest, JSON.stringify(current, null, 2)); return { installed: true, versions: await list() };
    } finally { busy = false; if (staging) { if (path.dirname(staging) !== versions || !path.basename(staging).startsWith('.install-')) throw Error('Unsafe update staging path'); await fs.rm(staging, { recursive: true, force: true }); } }
  }
  async function register(input) { await location(); const folder = await fs.realpath(input.path); const metadata = JSON.parse(await fs.readFile(path.join(folder, 'BUILD.json'), 'utf8')); if (metadata.name !== 'CodeStudio' || !/^\d+\.\d+\.\d+$/.test(metadata.version) || metadata.platform !== 'windows-x64') throw Error('请选择完整的 CodeStudio Windows 安装文件夹。'); await fs.access(path.join(folder, 'Start.cmd')); await fs.access(path.join(folder, 'server.mjs')); const items = (await list()).filter(item => !item.current); if (!items.some(item => item.path === folder)) items.push({ version: metadata.version, path: folder, registered: true }); await fs.writeFile(manifest, JSON.stringify(items, null, 2)); return { versions: await list() }; }
  async function launch(selected, selectedPath) {
    const item = (await list()).find(item => item.version === selected && (!selectedPath || item.path === selectedPath)); if (!item) throw Error('请选择已安装版本。'); const script = path.join(item.path, 'launch.ps1'); await fs.access(script);
    if (!item.current) { await backups.capture('before-version-switch'); await fs.mkdir(path.join(item.path, 'data'), { recursive: true }); for (const name of ['settings.json', 'mentor-sessions.json', 'learning.json']) { try { const file = path.join(dataDir, name); if ((await fs.lstat(file)).isSymbolicLink()) throw Error('设置不能是文件链接。'); await fs.copyFile(file, path.join(item.path, 'data', name)); } catch (error) { if (error.code !== 'ENOENT') throw error; } } }
    await new Promise((resolve, reject) => { const child = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { cwd: item.path, windowsHide: true, stdio: 'ignore' }); const timer = setTimeout(() => { child.kill(); reject(Error('目标版本启动超时，当前版本继续运行。')); }, 30000); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('目标版本未启动，当前版本继续运行。')); }); }); return { started: true, current: !!item.current };
  }
  return { check, download, list, register, launch, busy: () => busy };
}
