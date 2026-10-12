import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function createBackupStore({ dataDir, version, protect }) {
  const folder = path.join(dataDir, 'backups');
  const names = ['settings.json', 'mentor-sessions.json', 'learning.json'];
  async function capture(reason = 'manual') {
    const files = {};
    for (const name of names) {
      try { const raw = await fs.readFile(path.join(dataDir, name), 'utf8'); JSON.parse(raw); files[name] = raw; }
      catch (error) { if (error.code !== 'ENOENT') throw Error(`备份失败，请检查 ${name}，原文件未修改。`); }
    }
    const envelope = { format: 'CodeStudio encrypted backup', version: 1, appVersion: version, createdAt: new Date().toISOString(), reason,
      encryptedData: await protect(JSON.stringify({ files })) };
    await fs.mkdir(folder, { recursive: true });
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.studio-backup.json`;
    await fs.writeFile(path.join(folder, name), JSON.stringify(envelope, null, 2), { flag: 'wx', mode: 0o600 });
    return { name, backup: envelope };
  }
  async function decode(envelope) {
    if (envelope?.format !== 'CodeStudio encrypted backup' || envelope.version !== 1 || typeof envelope.encryptedData !== 'string' || envelope.encryptedData.length > 12_000_000) throw Error('请选择有效的 CodeStudio 加密备份。');
    let payload;
    try { payload = JSON.parse(await protect(envelope.encryptedData, true)); }
    catch { throw Error('备份无法解密，请使用创建备份时的同一台电脑和 Windows 账户。'); }
    const files = {};
    for (const name of names) if (payload.files?.[name] !== undefined) {
      if (typeof payload.files[name] !== 'string' || payload.files[name].length > 6_000_000) throw Error('备份内容过大或格式不正确。');
      JSON.parse(payload.files[name]); files[name] = payload.files[name];
    }
    if (!files['settings.json']) throw Error('备份缺少工作台设置。');
    return files;
  }
  async function list() {
    let entries; try { entries = await fs.readdir(folder); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return (await Promise.all(entries.filter(name => /^\d+-[a-f0-9]{8}\.studio-backup\.json$/.test(name)).map(async name => {
      const stat = await fs.lstat(path.join(folder, name)); if (!stat.isFile() || stat.size > 16_000_000) return null;
      try { const item = JSON.parse(await fs.readFile(path.join(folder, name), 'utf8')); return { name, createdAt: item.createdAt, appVersion: item.appVersion, reason: item.reason }; } catch { return null; }
    }))).filter(Boolean).sort((a, b) => b.name.localeCompare(a.name));
  }
  async function load(name) {
    if (!/^\d+-[a-f0-9]{8}\.studio-backup\.json$/.test(name || '')) throw Error('备份名称无效。');
    const file = path.join(folder, name); const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 16_000_000) throw Error('备份文件无效。');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }
  async function beforeUpgrade() {
    const marker = path.join(dataDir, 'backup-version.json');
    let previous = null; try { previous = JSON.parse(await fs.readFile(marker, 'utf8')); } catch {}
    if (previous?.version === version) return;
    try { await fs.access(path.join(dataDir, 'settings.json')); await capture('upgrade'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.writeFile(marker, JSON.stringify({ version }), { mode: 0o600 });
  }
  return { capture, decode, list, load, beforeUpgrade };
}
