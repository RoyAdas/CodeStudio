import React, { useEffect, useRef, useState } from 'react';
import { t, tr, useLocale } from './i18n';
import { normalizeMentorContext } from '../mentor-shared.mjs';
export function useWorkTools(workspace: string, api: any) {
  const [debug, setDebug] = useState<any>({ phase: 'idle', frames: [], variables: [] });
  const [tests, setTests] = useState<any>({ phase: 'idle', cases: [] });
  useEffect(() => {
    let canceled = false; setDebug({ phase: 'idle', frames: [], variables: [] }); setTests({ phase: 'idle', cases: [] });
    if (!workspace) return;
    Promise.all([api('debug'), api('tests')]).then(([d, ts]) => { if (!canceled) { setDebug(d); setTests(ts); } }).catch(() => {});
    const handler = (event: any) => { if (event.detail.workspace !== workspace) return; if (event.detail.type === 'debug') setDebug(event.detail.state); if (event.detail.type === 'tests') setTests(event.detail.state); };
    window.addEventListener('studio:work-tools', handler);
    return () => { canceled = true; window.removeEventListener('studio:work-tools', handler); };
  }, [workspace]);
  return { debug, tests, setDebug, setTests };
}
export function DebugPanel({ state, active, breakpoints, onToggle, onStart, onControl, onFocus, onExplain, disabled }: any) {
  useLocale(); const [entry, setEntry] = useState(false); const [busy, setBusy] = useState(false);
  async function control(action: string) { setBusy(true); try { await onControl(action); } finally { setBusy(false); } }
  const running = ['starting', 'running', 'paused'].includes(state.phase);
  return <div className="work-tools-panel" aria-label={t('Python 调试面板')}>
    <p>{t('点击代码左侧设置断点，观察每一步的变量。')}</p>
    {!running ? <><label className="work-check"><input type="checkbox" checked={entry} onChange={e => setEntry(e.target.checked)}/>{t('在程序入口暂停')}</label><button className="primary-button" disabled={disabled || !active.endsWith('.py') || busy} onClick={async () => { setBusy(true); try { await onStart(entry); } finally { setBusy(false); } }}>{t('开始 Python 调试')}</button></> : <div className="debug-actions">{state.phase === 'paused' ? [['continue', '继续执行'], ['next', '单步跳过'], ['stepIn', '单步进入'], ['stepOut', '单步跳出']].map(([id, name]) => <button key={id} disabled={busy || !state.threadId} onClick={() => control(id)}>{t(name)}</button>) : <button disabled={busy || state.phase === 'starting'} onClick={() => control('pause')}>{t('暂停执行')}</button>}<button disabled={busy} onClick={() => control('stop')}>{t('停止调试')}</button></div>}
    <div className="work-phase">{t(({ idle: '尚未调试', starting: '启动调试中', running: '正在执行', paused: '已暂停', finished: '调试已结束' } as any)[state.phase])}</div>
    {state.error && <p className="work-error">{t(state.error)}</p>}
    <h4>{t('断点')}</h4>{Object.entries(breakpoints).flatMap(([file, lines]: any) => lines.map((line: number) => <div className="breakpoint-row" key={file + ':' + line}><button onClick={() => onFocus(file, line)}>{file}:{line}</button><button aria-label={tr `移除断点 ${file}:${line}`} onClick={() => onToggle(file, line)}>×</button></div>))}
    <h4>{t('调用栈')}</h4>{state.frames?.map((frame: any) => <button className="stack-row" key={frame.id} onClick={() => onFocus(frame.path, frame.line)}><strong>{frame.name}</strong><small>{frame.path}:{frame.line}</small></button>)}
    <h4>{t('变量')}</h4><div className="debug-variables">{state.variables?.filter((item: any) => !item.name.startsWith('__')).map((item: any, i: number) => <div key={i} title={item.type}><strong>{item.name}</strong><code>{item.value}</code></div>)}</div>
    {state.phase === 'paused' && <button className="secondary-button" disabled={!state.frames?.length} onClick={onExplain}>{t('请导师解释当前状态')}</button>}
    {state.output && <><h4>{t('调试输出')}</h4><pre className="work-output">{state.output}</pre></>}
  </div>;
}
export function TestPanel({ state, context, api, saveAll, disabled, onGenerate, onReview, onStarted, toast }: any) {
  useLocale(); const [directory, setDirectory] = useState('.'); const [pattern, setPattern] = useState('test*.py'); const [busy, setBusy] = useState(false);
  const evidence = normalizeMentorContext({ ...context, tests: state }).tests;
  async function start() { setBusy(true); try { if (!await saveAll()) return; const result = await api('tests/start', { directory, pattern }); onStarted(result); } catch (error: any) { toast(error.message); } finally { setBusy(false); } }
  return <div className="work-tools-panel" aria-label={t('Python 测试面板')}><p>{t('运行 unittest 测试，使用项目当前的 Python 环境。')}</p>
    <label>{t('测试目录')}<input aria-label={t('测试目录')} value={directory} onChange={e => setDirectory(e.target.value)}/></label>
    <label>{t('文件模式')}<input aria-label={t('测试文件模式')} value={pattern} onChange={e => setPattern(e.target.value)}/></label>
    {state.phase === 'running' ? <button className="secondary-button" onClick={async () => { try { await api('tests/stop', {}); } catch (error: any) { toast(error.message); } }}>{t('停止测试')}</button> : <button className="primary-button" disabled={disabled || busy} onClick={start}>{t('保存并运行测试')}</button>}
    <button className="secondary-button" disabled={busy || state.phase === 'running'} onClick={onGenerate}>{t('AI 生成测试建议')}</button>
    {state.phase === 'finished' && <><div className={`test-summary ${state.passed ? 'success' : 'work-error'}`}>{tr `通过 ${state.cases.filter((item: any) => item.status === 'passed').length} / ${state.cases.length}`}</div><p className={!evidence?.matchesCurrentCode ? 'work-error' : ''}>{evidence?.matchesCurrentCode ? t('测试对应当前打开的代码') : t('代码已变化，请重新运行测试')}</p><button className="secondary-button" disabled={!evidence?.matchesCurrentCode} onClick={onReview}>{t('请导师验收测试结果')}</button></>}
    {state.error && <p className="work-error">{t(state.error)}</p>}
    <div className="test-cases">{state.cases?.map((item: any, i: number) => <details key={i}><summary><i className={item.status === 'passed' ? 'ready-dot' : 'missing-dot'}/><span>{item.id}</span><small>{t(({ passed: '通过', failed: '失败', error: '错误', skipped: '跳过', expectedFailure: '预期失败', unexpectedSuccess: '意外通过' } as any)[item.status])}</small></summary>{item.detail && <pre>{item.detail}</pre>}</details>)}</div>
    {state.output && <details><summary>{t('完整测试输出')}</summary><pre className="work-output">{state.output}</pre></details>}
  </div>;
}
function Diff({ change }: any) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let editor: any, original: any, modified: any, canceled = false;
    import('monaco-editor').then(monaco => {
      if (canceled) return;
      const id = crypto.randomUUID(); const lang = change.path.endsWith('.py') ? 'python' : /\.(c|cpp|h|hpp)$/.test(change.path) ? 'cpp' : undefined;
      original = monaco.editor.createModel(change.before || '', lang, monaco.Uri.parse(`inmemory://diff/${id}/original`));
      modified = monaco.editor.createModel(change.after, lang, monaco.Uri.parse(`inmemory://diff/${id}/modified`));
      editor = monaco.editor.createDiffEditor(host.current!, { theme: 'studio', automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false }); editor.setModel({ original, modified });
    });
    return () => { canceled = true; editor?.dispose(); original?.dispose(); modified?.dispose(); };
  }, [change]);
  return <div className="change-diff" ref={host}/>;
}
export function ChangesReview({ kind, files, tests, api, onApply, onClose, toast }: any) {
  useLocale(); const [instruction, setInstruction] = useState(kind === 'tests' ? t('为当前代码编写 unittest 测试，覆盖正常情况和边界情况。') : '');
  const [proposal, setProposal] = useState<any>(null); const [index, setIndex] = useState(0); const [selected, setSelected] = useState<Set<string>>(new Set()); const [busy, setBusy] = useState(false); const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function generate() { setBusy(true); const job = new AbortController(); controller.current = job;
    try { const result = await api('changes', { kind, instruction, files: files.slice(0, 6).map((file: any) => ({ path: file.path, content: file.content })), tests }, job.signal); setProposal(result); setIndex(0); setSelected(new Set(result.changes.map((item: any) => item.path))); }
    catch (error: any) { if (!job.signal.aborted) toast(error.message); } finally { setBusy(false); controller.current = null; }
  }
  const change = proposal?.changes[index];
  return <div className="modal-backdrop"><section className="changes-modal" role="dialog" aria-modal="true" aria-label={t('AI 修改对比')}><div className="modal-title"><h2>{kind === 'tests' ? t('AI 测试建议') : t('AI 修改对比')}</h2><button aria-label={t('关闭修改对比')} onClick={onClose}>×</button></div>
    {!proposal ? <div className="change-request"><p>{t('AI 建议会先显示差异，接受后成为未保存的编辑。')}</p><p>{t('将发送前六个打开文件及所选测试结果。')}</p><textarea aria-label={t('修改需求')} rows={5} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder={t('描述希望修改的功能或需要修复的问题…')}/><div>{busy ? <button className="secondary-button" onClick={() => controller.current?.abort()}>{t('停止生成')}</button> : <button className="primary-button" disabled={!files.length || !instruction.trim()} onClick={generate}>{t('生成修改建议')}</button>}</div></div> : <><p className="change-summary">{proposal.summary}</p><div className="change-layout"><div className="change-files">{proposal.changes.map((item: any, i: number) => <div key={item.path} className={i === index ? 'active' : ''}><input type="checkbox" aria-label={tr `选择修改 ${item.path}`} checked={selected.has(item.path)} onChange={e => setSelected(old => { const next = new Set(old); e.target.checked ? next.add(item.path) : next.delete(item.path); return next; })}/><button onClick={() => setIndex(i)}>{item.path}{item.before === null && <small>{t('新文件')}</small>}</button></div>)}</div><div className="change-preview"><p>{change?.reason}</p><div className="diff-labels"><span>{t('修改前')}</span><span>{t('建议修改后')}</span></div>{change && <Diff change={change}/>}</div></div><div className="change-footer"><span>{t('接受后请检查代码，再按 Ctrl+S 保存。')}</span><button className="secondary-button" onClick={onClose}>{t('拒绝修改')}</button><button className="primary-button" disabled={!selected.size} onClick={async () => { if (await onApply(proposal.changes.filter((item: any) => selected.has(item.path)))) onClose(); }}>{t('接受选中的修改')}</button></div></>}
  </section></div>;
}
