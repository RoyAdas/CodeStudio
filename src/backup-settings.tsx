import { t, tr, useLocale, setLocale } from './i18n';
import React, { useEffect, useState } from 'react';
import { Download, Upload, RotateCw } from 'lucide-react';
export function BackupSettings({ api, toast, beforeRestore }: any) {
    const [oldPath, setOldPath] = useState('');
    const [items, setItems] = useState<any[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function refresh() { const result = await api('backups'); setItems(result.backups); setError(result.error || ''); }
    useEffect(() => { refresh().catch(e => setError(e.message)); }, []);
    async function exportBackup() {
        setBusy(true);
        setError('');
        try {
            const result = await api('backups/export', {});
            const url = URL.createObjectURL(new Blob([JSON.stringify(result.backup, null, 2)], { type: 'application/json' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = result.name;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            await refresh();
            toast(t("已导出加密备份。"));
        }
        catch (e: any) {
            setError(e.message);
        }
        finally {
            setBusy(false);
        }
    }
    async function restore(input: any) {
        if (!beforeRestore() || !window.confirm(t("恢复备份会替换工作台设置和导师进度。当前设置会先自动备份，代码文件不会修改。继续恢复？")))
            return;
        setBusy(true);
        setError('');
        try {
            await api(input.path ? 'backups/migrate' : 'backups/import', input);
            window.location.reload();
        }
        catch (e: any) {
            setError(e.message);
            setBusy(false);
        }
    }
    return <div className="backup-settings"><h3>{t("升级与备份")}</h3><p className="muted">{t("备份包含 API 配置、加密密钥、界面语言和导师进度。它只能在同一电脑、同一 Windows 账户下恢复；项目代码与虚拟环境请单独保留。")}</p><div className="backup-actions"><button className="secondary-button" disabled={busy} onClick={exportBackup}><Download size={14}/>{t("导出加密备份")}</button><label className="secondary-button"><Upload size={14}/>{t("导入备份")}<input type="file" accept=".json" aria-label={t("导入加密备份")} disabled={busy} onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file)
        return; if (file.size > 16000000) {
        setError(t("备份文件过大。"));
        return;
    } try {
        await restore({ backup: JSON.parse(await file.text()) });
    }
    catch {
        setError(t("备份文件不是有效 JSON。"));
    } }}/></label><button className="icon-button" aria-label={t("刷新备份")} disabled={busy} onClick={() => refresh().catch(e => setError(e.message))}><RotateCw size={14}/></button></div>{error && <p className="connection-result" role="alert">{t(error)}</p>}<label>{t('旧版本工作台文件夹')}<input aria-label={t('旧版本工作台文件夹')} value={oldPath} placeholder="G:\CodeStudio" onChange={e => setOldPath(e.target.value)}/></label><button className="secondary-button" disabled={busy || !oldPath.trim()} onClick={() => restore({ path: oldPath.trim() })}>{t('迁移旧版本设置与导师进度')}</button><p className="muted">{t('v0.1/v0.2 可直接填写旧工作台文件夹路径。先停止旧版本，迁移只读取旧数据，不修改原文件。')}</p><h4>{t("本机备份")}</h4><div className="backup-list">{items.slice(0, 20).map(item => <div key={item.name}><span>{new Date(item.createdAt).toLocaleString()}<small>v{item.appVersion} · {item.reason === 'upgrade' ? t("升级前") : item.reason === 'before-restore' ? t("恢复前") : t("手动")}</small></span><button className="secondary-button" disabled={busy} onClick={() => restore({ name: item.name })}>{t("恢复")}</button></div>)}{!items.length && <p className="muted">{t("尚无备份。建议升级前先导出一份。")}</p>}</div><p className="muted">{t("升级方法：旧版本导出备份 → 停止旧版本 → 解压新版本并启动 → 导入备份。首次读取旧设置和每次恢复前也会自动备份，保存在 data/backups。")}</p></div>;
}
