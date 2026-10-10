import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Sparkles, Play, Pause, RotateCw, CheckCircle2, ChevronRight, AlertCircle, CircleHelp, Send, Plus, FileCode2, Timer, ShieldCheck, ArrowRight, Square, History } from 'lucide-react';
import { normalizeMentorContext, contextFingerprint } from '../mentor-shared.mjs';

const token = document.querySelector<HTMLMetaElement>('meta[name="studio-token"]')!.content;
async function request(action = '', data?: any, signal?: AbortSignal) {
  const response = await fetch(`/api/mentor${action ? '/' + action : ''}`, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-Studio-Token': token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data), signal });
  const result = await response.json(); if (!response.ok) throw Error(result.error || '导师操作失败'); return result;
}
export function useTaskMentor({ workspace, context, aiReady, connection, otherBusy, configure, toast }: any) {
  const [session, setSession] = useState<any>(null); const [phase, setPhase] = useState('loading'); const [error, setError] = useState(''); const [queued, setQueued] = useState(''); const [visible, setVisible] = useState(document.visibilityState === 'visible');
  const normalized = useMemo(() => normalizeMentorContext(context), [context]); const signature = contextFingerprint(normalized);
  const snapshotRef = useRef(normalized); snapshotRef.current = normalized;
  const actions = useRef({ aiReady, connection, configure, toast }); actions.current = { aiReady, connection, configure, toast };
  const workspaceRef = useRef(workspace); workspaceRef.current = workspace;
  const sessionRef = useRef<any>(session); sessionRef.current = session;
  const inflight = useRef<any>(null); const lastRunHandled = useRef('');
  useEffect(() => { const onVisibility = () => setVisible(document.visibilityState === 'visible'); document.addEventListener('visibilitychange', onVisibility); return () => document.removeEventListener('visibilitychange', onVisibility); }, []);
  useEffect(() => {
    inflight.current?.controller.abort(); inflight.current = null; setSession(null); setError(''); setPhase('loading'); setQueued(''); lastRunHandled.current = snapshotRef.current.run?.id || '';
    if (!workspace) return;
    let canceled = false; const controller = new AbortController();
    request('', undefined, controller.signal).then(result => { if (!canceled) { setSession(result.session); setPhase(result.phase || 'idle'); } }).catch(e => { if (!canceled && e.name !== 'AbortError') { setError(e.message); setPhase('idle'); } });
    const onEvent = (event: any) => { if (event.detail.workspace !== workspace) return; setSession(event.detail.session); setPhase(event.detail.phase || 'idle'); };
    window.addEventListener('studio:mentor', onEvent);
    return () => { canceled = true; controller.abort(); inflight.current?.controller.abort(); inflight.current = null; window.removeEventListener('studio:mentor', onEvent); };
  }, [workspace]);
  const perform = useCallback(async (action: string, extra: any = {}) => {
    const { aiReady, connection, configure, toast } = actions.current;
    if ((action === 'start' || action === 'check') && !aiReady) { configure(); toast('请先配置 AI 服务，再提交任务。'); return null; }
    if ((action === 'start' || action === 'check') && !connection) { toast('本地连接已断开，请刷新工作台。'); return null; }
    if (['pause', 'reset'].includes(action)) { inflight.current?.controller.abort(); inflight.current = null; }
    if (inflight.current) return null;
    const job = { action, controller: new AbortController(), signature: contextFingerprint(snapshotRef.current), workspace, id: Date.now() };
    inflight.current = job; setPhase(action === 'start' ? 'planning' : action === 'check' ? 'checking' : 'control'); setError(''); setQueued('');
    if (action === 'check' && snapshotRef.current.run?.phase === 'finished') lastRunHandled.current = snapshotRef.current.run.id;
    try {
      const result = await request(action, { sessionId: sessionRef.current?.id, ...extra, context: snapshotRef.current }, job.controller.signal);
      if (workspaceRef.current !== job.workspace || inflight.current !== job) return null;
      if (!result.canceled) setSession(result.session);
      if (result.skipped && result.reason === 'cooldown') setQueued('等待检查间隔');
      return result;
    } catch (e: any) { if (e.name !== 'AbortError' && workspaceRef.current === job.workspace) { setError(e.message); if (action !== 'check') toast(e.message); } return null; }
    finally { if (inflight.current === job) { inflight.current = null; setPhase('idle'); } }
  }, [workspace]);
  useEffect(() => {
    const job = inflight.current;
    if (job?.action === 'check' && job.signature !== signature) { job.controller.abort(); inflight.current = null; setPhase('idle'); setQueued('代码已更新，准备重新检查'); }
  }, [signature]);
  useEffect(() => {
    setQueued('');
    if (!session || session.status !== 'active' || !aiReady || !connection || !visible || otherBusy || phase !== 'idle' || !normalized.files.length || normalized.run?.phase === 'run' || normalized.run?.phase === 'compile') return;
    if (session.review?.contextFingerprint === signature && session.review.step === session.currentStep) return;
    if (!session.review && session.baselineFingerprint === signature) return;
    const finishedRun = normalized.run?.phase === 'finished' && normalized.run.id !== lastRunHandled.current;
    const trigger = finishedRun ? 'run' : 'idle';
    if (session.options.autoMode === 'manual' || (trigger === 'idle' && session.options.autoMode !== 'idle')) return;
    const cooldown = Math.max(0, session.options.minInterval - (Date.now() - session.lastCheckAt));
    const delay = Math.max(finishedRun ? 100 : session.options.idleDelay, cooldown);
    setQueued(cooldown > 0 ? '等待检查间隔，随后检查最新代码' : finishedRun ? '运行结束，准备检查结果' : '停笔 5 秒后检查');
    const timer = window.setTimeout(() => { if (document.visibilityState === 'visible') void perform('check', { trigger }); }, delay);
    return () => window.clearTimeout(timer);
  }, [signature, session, phase, aiReady, connection, visible, otherBusy, perform]);
  return { session, phase, error, queued, signature, fresh: !!session?.review && session.review.contextFingerprint === signature && session.review.step === session.currentStep, busy: ['planning', 'checking', 'control'].includes(phase), perform };
}

export function TaskMentor({ mentor, onConfigure, onFocus }: any) {
  const { session, phase, error, queued, fresh, busy, perform } = mentor;
  const [task, setTask] = useState(''); const [level, setLevel] = useState('会一点基础，希望通过项目练习'); const [question, setQuestion] = useState(''); const [showHistory, setShowHistory] = useState(false);
  const examples = [ ['PyTorch / CNN', '我会一点 Python，想用 PyTorch 一步一步写一个手写数字分类 CNN。先检查环境，从张量和网络结构开始，再训练、验证，不要直接给我整份代码。'], ['Python 项目', '带我用 Python 写一个命令行记账程序：记录金额、计算总支出、保存为 JSON。每次让我实现一个小功能。'], ['C++ 练习', '带我用 C++ 实现一个单向链表，支持追加、查找和删除。先从节点结构和最小运行示例开始。'] ];
  const step = session?.steps[session.currentStep]; const review = session?.review;
  const status = phase === 'planning' ? '正在安排学习路线' : phase === 'checking' ? '正在检查代码' : session?.status === 'paused' ? '已暂停' : session?.status === 'completed' ? '任务已完成' : queued || (session ? '观察代码变化中' : '先给导师一个任务');
  if (!session) return <div className="task-mentor mentor-onboarding"><div className="task-intro"><span className="welcome-spark"><BookOpen size={24}/></span><span className="mentor-eyebrow">实时任务导师</span><h2>你定目标，导师陪你完成</h2><p>先把任务拆成小步骤。你自己写代码，导师结合编辑内容与运行结果给提示。</p></div><label className="task-label">我想完成的任务<textarea aria-label="导师任务" value={task} onChange={e => setTask(e.target.value)} placeholder="例如：用 PyTorch 写一个 CNN，从零讲清每一步，不直接给整份答案。" rows={5}/></label><div className="task-examples">{examples.map(([name, value]) => <button key={name} onClick={() => setTask(value)}>{name}<Plus size={10}/></button>)}</div><label className="task-label">我的基础<select aria-label="学习基础" value={level} onChange={e => setLevel(e.target.value)}><option>刚开始学，讲解尽量直观</option><option>会一点基础，希望通过项目练习</option><option>已有基础，希望深入实现细节</option></select></label><button className="primary-button task-start" disabled={!task.trim() || busy} onClick={() => perform('start', { task, level })}>{phase === 'planning' ? <RotateCw size={14} className="spin"/> : <Sparkles size={14}/>} {phase === 'planning' ? '正在拆分任务…' : '提交任务，开始指导'}</button>{phase === 'planning' && <button className="text-button" onClick={() => perform('reset')}>取消生成</button>}{error && <div className="mentor-error"><AlertCircle size={14}/>{error}</div>}<div className="mentor-explainer"><div><Timer size={14}/><span>停笔约 5 秒后检查；运行结束后检查结果。</span></div><div><ShieldCheck size={14}/><span>开始任务后使用你配置的 API，自动请求至少间隔 20 秒，默认每小时上限 30 次；可随时暂停。</span></div><div><FileCode2 size={14}/><span>发送最多 6 个已打开文件（含未保存代码）及运行输出；默认排除常见密钥文件和 .env。</span></div></div><button className="text-button mentor-configure" onClick={onConfigure}>设置 AI 服务<ChevronRight size={12}/></button></div>;
  return <div className="task-mentor"><div className="mentor-session-heading"><span className="mentor-eyebrow">任务 · {session.currentStep + 1} / {session.steps.length}</span><button title="结束此任务，创建新任务" onClick={() => { if (window.confirm('结束当前任务并创建新任务？当前任务进度会清除。')) void perform('reset'); }}><Plus size={13}/>新任务</button></div><h2 className="mentor-task-title">{session.title}</h2><p className="mentor-overview">{session.overview}</p><div className="mentor-live-status"><i className={session.status === 'paused' ? 'paused' : ''}/><span>{status}</span>{busy && <RotateCw size={11} className="spin"/>}</div><div className="mentor-controls"><button aria-label={session.status === 'paused' ? '恢复导师' : '暂停导师'} disabled={session.status === 'completed' || phase === 'control'} onClick={() => perform(session.status === 'paused' ? 'resume' : 'pause')}>{session.status === 'paused' ? <Play size={13}/> : <Pause size={13}/>} {session.status === 'paused' ? '恢复' : '暂停'}</button><label><span>自动检查</span><select aria-label="导师自动检查" disabled={busy} value={session.options.autoMode} onChange={e => perform('options', { autoMode: e.target.value })}><option value="idle">停笔和运行后</option><option value="run">仅运行后</option><option value="manual">只手动检查</option></select></label><label><span>最短间隔</span><select aria-label="导师检查间隔" disabled={busy} value={session.options.minInterval} onChange={e => perform('options', { minInterval: Number(e.target.value) })}><option value="20000">20 秒</option><option value="30000">30 秒</option><option value="60000">60 秒</option></select></label><label><span>每小时自动上限</span><select aria-label="导师每小时检查上限" disabled={busy} value={session.options.maxAutoChecksPerHour ?? 30} onChange={e => perform('options', { maxAutoChecksPerHour: Number(e.target.value) })}><option value="10">10 次</option><option value="30">30 次</option><option value="60">60 次</option><option value="0">不限制</option></select></label></div>
    <div className="mentor-steps" aria-label="任务步骤">{session.steps.map((item: any, index: number) => <div key={item.id} className={`mentor-step ${index === session.currentStep ? 'current' : ''} ${item.completed ? 'done' : ''}`}><span>{item.completed ? <CheckCircle2 size={13}/> : index + 1}</span><div><strong>{item.title}</strong>{index === session.currentStep && session.status !== 'completed' && <p>{item.goal}</p>}</div></div>)}</div>
    {session.status === 'completed' ? <div className="mentor-completed"><CheckCircle2 size={28}/><h3>任务已完成</h3><p>你完成了所有小步骤。可以继续提问，或创建下一个任务。</p></div> : <><div className="mentor-current-goal"><span>这一步怎样验证</span><p>{step.acceptance}</p></div><div className={`mentor-review ${fresh && review?.status === 'passed' ? 'passed' : fresh && review?.status === 'needs_fix' ? 'needs-fix' : ''}`}><div><Sparkles size={14}/><strong>{fresh ? ({ passed: '这一步已通过检查', needs_fix: '先解决这个问题', in_progress: '继续完成这个小目标' }[review.status] || '导师提示') : review ? '代码已更新，准备重新检查' : '先给你一点提示'}</strong>{review && <small>{fresh ? (review.runEvidence ? '代码 + 运行结果' : '静态代码检查') : '旧版本反馈'}</small>}</div>{review && <p className={!fresh ? 'stale-review' : ''}>{review.note}</p>}<p className="mentor-hint">{fresh ? review.hint || step.hint : step.hint}</p>{fresh && review.evidence?.length > 0 && <div className="mentor-evidence">{review.evidence.map((item: any, index: number) => <button key={index} onClick={() => onFocus(item.path, item.line)}><FileCode2 size={12}/><span>{item.path}:{item.line}<small>{item.message}</small></span><ChevronRight size={11}/></button>)}</div>}</div><div className="mentor-step-actions"><button className="secondary-button" disabled={busy} onClick={() => perform('check', { trigger: 'manual' })}>{phase === 'checking' ? <RotateCw size={13} className="spin"/> : <CircleHelp size={13}/>}检查这一步</button><button className="primary-button" disabled={busy || !fresh || review?.status !== 'passed'} onClick={() => perform('advance')}>{session.currentStep === session.steps.length - 1 ? '完成任务' : '进入下一步'}<ArrowRight size={13}/></button></div><form className="mentor-question" onSubmit={async e => { e.preventDefault(); if (!question.trim()) return; const result = await perform('check', { trigger: 'question', question }); if (result && !result.skipped) setQuestion(''); }}><textarea aria-label="询问任务导师" value={question} onChange={e => setQuestion(e.target.value)} placeholder="这一步哪里不懂？问导师，先给我提示…" rows={2}/><button aria-label="发送导师问题" disabled={busy || !question.trim()}><Send size={13}/></button></form></>}
    {(error || session.lastError) && <div className="mentor-error"><AlertCircle size={14}/><span>{error || session.lastError}<small>自动检查已暂停，处理后可恢复或手动重试。</small></span></div>}
    <button className="mentor-history-toggle" onClick={() => setShowHistory(!showHistory)}><History size={12}/>指导记录<span>自动检查 {session.autoChecks} 次</span><ChevronRight size={12} style={{ transform: showHistory ? 'rotate(90deg)' : undefined }}/></button>{showHistory && <div className="mentor-history">{session.history.slice().reverse().map((item: any, i: number) => <div key={i}><span>{new Date(item.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · 第 {item.step + 1} 步{item.trigger ? ` · ${{ idle: '停笔', run: '运行后', manual: '手动', question: '提问' }[item.trigger] || item.trigger}` : ''}</span><p>{item.note}</p></div>)}</div>}<div className="mentor-footnote">本任务已发起 {session.metrics?.requests || 0} 次请求；{session.metrics?.usageResponses ? `服务已报告 ${session.metrics.reportedTokens.toLocaleString()} Token（可能不完整）` : '服务未报告 Token 用量'}。手动请求仍可能收费，统计不等于账单。<br/>任务进度保存在本机。代码由你编辑，步骤由你确认推进。</div>
  </div>;
}
