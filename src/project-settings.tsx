import React, { useState } from 'react';
import { Settings, X, FolderOpen, Terminal, AlertCircle, RotateCw } from 'lucide-react';
import './project.css';

type Project = { version: number; python: { mode: string; venv: string }; build: { c: string[]; cpp: string[]; includeDirs: string[]; cStandard: string; cppStandard: string } };
type Props = { project: any; tools: any; files: string[]; api: (route: string, data?: any) => Promise<any>; onClose: () => void; onSaved: (data: any) => void; beforeSave: () => boolean };

export function ProjectSettings({ project, tools, files, api, onClose, onSaved, beforeSave }: Props) {
  const [form, setForm] = useState<Project>(() => structuredClone(project.config));
  const [tab, setTab] = useState('python'); const [busy, setBusy] = useState('');
  const [result, setResult] = useState(''); const [localTools, setLocalTools] = useState(tools);
  const [includeDirs, setIncludeDirs] = useState(form.build.includeDirs.join('\n'));
  function selectSource(kind: 'c' | 'cpp', file: string, checked: boolean) {
    setForm(old => ({ ...old, build: { ...old.build, [kind]: checked ? [...new Set([...old.build[kind], file])] : old.build[kind].filter(value => value !== file) } }));
  }
  async function save(create = false) {
    if (busy || !beforeSave()) return;
    setBusy(create ? 'create' : 'save'); setResult('');
    try {
      const input = { ...form, build: { ...form.build, includeDirs: includeDirs.split(/\r?\n/).map(value => value.trim()).filter(Boolean) } };
      const saved = await api('project', input); onSaved(saved); setForm(saved.project.config); setLocalTools(saved.tools);
      if (create) {
        const created = await api('project/venv', {}); onSaved(created); setLocalTools(created.tools);
        setResult(`虚拟环境 ${input.python.venv} 已创建。按 F5 即可使用项目环境运行。`);
      } else setResult('项目配置已保存；下次按 F5 时生效。');
    } catch (error: any) { setResult(error.message); }
    finally { setBusy(''); }
  }
  const choices = (kind: 'c' | 'cpp') => [...new Set([...files.filter(file => (kind === 'c' ? /\.c$/i : /\.(c|cpp|cc|cxx)$/i).test(file)), ...form.build[kind]])].sort();
  return <div className="modal-backdrop" onMouseDown={event => !busy && event.target === event.currentTarget && onClose()}>
    <section className="settings-modal project-modal" role="dialog" aria-modal="true" aria-label="项目设置">
      <div className="modal-title"><div><Settings size={18}/><h2>项目设置</h2></div><button className="icon-button" aria-label="关闭项目设置" disabled={!!busy} onClick={onClose}><X size={18}/></button></div>
      <div className="settings-tabs"><button className={tab === 'python' ? 'active' : ''} onClick={() => setTab('python')}><Terminal size={15}/>Python 环境</button><button className={tab === 'build' ? 'active' : ''} onClick={() => setTab('build')}><FolderOpen size={15}/>C / C++ 构建</button></div>
      <div className="settings-body">
        {project.error && <p className="connection-result"><AlertCircle size={15}/>{project.error} 请修正配置文件，或修改下面的配置并保存。</p>}
        {tab === 'python' ? <>
          <div className="settings-intro"><div><h3>每个项目使用自己的 Python 环境</h3><p>自动模式优先使用项目虚拟环境；尚未创建时使用系统 Python。</p></div></div>
          <label>Python 运行方式<select aria-label="Python 运行方式" value={form.python.mode} disabled={!!busy} onChange={event => setForm(old => ({ ...old, python: { ...old.python, mode: event.target.value } }))}><option value="auto">自动：优先项目虚拟环境</option><option value="venv">仅使用项目虚拟环境</option><option value="system">使用系统 Python</option></select></label>
          <label>虚拟环境文件夹<input aria-label="虚拟环境文件夹" value={form.python.venv} disabled={!!busy} onChange={event => setForm(old => ({ ...old, python: { ...old.python, venv: event.target.value } }))}/><small>位于项目根目录，如 .venv。创建操作使用系统 Python，不下载第三方依赖，也不会覆盖已有目录。</small></label>
          <div className="project-tool"><strong>当前生效的解释器 · {localTools.python.environment === 'venv' ? '项目虚拟环境' : '系统 Python'}</strong><code>{localTools.python.path || '尚未配置'}</code><span>{localTools.python.version}</span></div>
          <button className="secondary-button" disabled={!!busy || form.python.mode === 'system' || project.environmentBusy} onClick={() => save(true)}>{busy === 'create' && <RotateCw size={14} className="spin"/>}{busy === 'create' ? '正在创建，可能需要一两分钟…' : '保存配置并创建虚拟环境'}</button>
          <p className="muted">缺少系统 Python 时，请先在“设置 → 运行环境”配置。环境中的包需要你自行安装；环境文件夹应保留在本机。</p>
        </> : <>
          <div className="settings-intro"><div><h3>选择需要一起编译的文件</h3><p>按 F5 会保存所有打开的修改，再编译对应语言的列表。留空时继续运行当前单文件。</p></div></div>
          {(['c', 'cpp'] as const).map(kind => <fieldset className="source-list" key={kind} disabled={!!busy}><legend>{kind === 'c' ? 'C 项目源文件' : 'C++ 项目源文件'} · {form.build[kind].length} 个</legend>
            <label>语言标准<select aria-label={kind === 'c' ? 'C 语言标准' : 'C++ 语言标准'} value={kind === 'c' ? form.build.cStandard : form.build.cppStandard} onChange={event => setForm(old => ({ ...old, build: { ...old.build, [kind === 'c' ? 'cStandard' : 'cppStandard']: event.target.value } }))}>{(kind === 'c' ? ['c99', 'c11', 'c17', 'c23'] : ['c++11', 'c++14', 'c++17', 'c++20', 'c++23']).map(standard => <option key={standard}>{standard}</option>)}</select></label>
            <div className="source-options">{choices(kind).map(file => <label className="checkbox-label" key={file}><input type="checkbox" aria-label={`${kind === 'c' ? 'C' : 'C++'} 构建 ${file}`} checked={form.build[kind].includes(file)} onChange={event => selectSource(kind, file, event.target.checked)}/><span>{file}</span></label>)}{!choices(kind).length && <p className="muted">先在项目里创建源文件，重新打开项目设置即可选择。</p>}</div>
          </fieldset>)}
          <label>额外头文件目录<textarea aria-label="额外头文件目录" rows={3} value={includeDirs} disabled={!!busy} placeholder={'include\n公共头文件'} onChange={event => setIncludeDirs(event.target.value)}/><small>每行一个工作区内的相对目录。每个源文件所在目录始终支持相对头文件引用。</small></label>
          <p className="muted">C++ 列表也可包含 C 文件：C 文件用 C 编译器编译，最后由 C++ 编译器链接。语言标准需由你安装的编译器支持；目前不支持 CMake 和外部库配置。</p>
        </>}
        {result && <p className="connection-result" role="status">{result}</p>}
      </div>
      <div className="modal-footer"><span>配置保存为项目内的 .codestudio.json</span><button className="secondary-button" disabled={!!busy} onClick={onClose}>关闭</button><button className="primary-button" disabled={!!busy || project.environmentBusy} onClick={() => save()}>{busy === 'save' ? '保存中…' : '保存项目设置'}</button></div>
    </section>
  </div>;
}
