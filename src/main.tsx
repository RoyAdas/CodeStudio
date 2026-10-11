import { t, tr, useLocale, setLocale } from './i18n';
import React, { useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Braces, Files, Search, Settings, Sparkles, Play, Square, ChevronRight, ChevronDown, X, Plus, FilePlus2, FolderPlus, FolderOpen, RotateCw, Check, Terminal, Send, Bot, Code2, Copy, ArrowDownToLine, Keyboard, CircleHelp, CheckCircle2, AlertCircle, WifiOff, PanelRightClose, PanelRightOpen, Save, Plug, ShieldCheck, MoreHorizontal, WandSparkles, BookOpen, Trash2 } from 'lucide-react';
import './style.css';
import './mentor.css';
import { TaskMentor, useTaskMentor } from './task-mentor';
import { ProjectSettings } from './project-settings';
import { BackupSettings } from './backup-settings';
import { attachLanguageServices } from './language-client';
import { streamChat } from './chat-stream';
const token = document.querySelector<HTMLMetaElement>('meta[name="studio-token"]')!.content;
async function api(route: string, data?: any, signal?: AbortSignal) {
    const response = await fetch(`/api/${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-Studio-Token': token, ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: data === undefined ? undefined : JSON.stringify(data), signal });
    const value = await response.json();
    if (!response.ok)
        throw Error(t(value.error) || t("操作失败"));
    return value;
}
const language = (file = '') => ({ py: 'python', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', js: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript', json: 'json', html: 'html', css: 'css', md: 'markdown', txt: 'plaintext' }[file.split('.').pop()!.toLowerCase()] || 'plaintext');
const langLabel = (id: string) => ({ python: 'Python', c: 'C', cpp: 'C++', javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON', markdown: 'Markdown', plaintext: t("纯文本") }[id] || id.toUpperCase());
const basename = (file: string) => file.split(/[\\/]/).pop() || file;
function FileIcon({ file }: {
    file: string;
}) { const lang = language(file); return <span className={`file-icon ${lang}`}>{({ python: 'Py', c: 'C', cpp: 'C++', javascript: 'JS', typescript: 'TS', json: '{}', markdown: 'M↓' }[lang] || '◇')}</span>; }
type OpenFile = {
    path: string;
    content: string;
    saved: string;
};
type Message = {
    role: 'user' | 'assistant';
    content: string;
    error?: boolean;
    incomplete?: boolean;
};
const snippets: Record<string, Array<[
    string,
    string,
    string
]>> = {
    python: [['print', 'print(${1:value})', t("输出到终端")], ['input', t("input(\"${1:请输入：}\")"), t("读取输入")], ['def', 'def ${1:function_name}(${2:args}):\n\t${0:pass}', t("定义函数")], ['for', 'for ${1:item} in ${2:items}:\n\t${0:pass}', t("for 循环")], ['if', 'if ${1:condition}:\n\t${0:pass}', t("条件判断")], ['main', 'if __name__ == "__main__":\n\t${0:main()}', t("程序入口")], ['try', 'try:\n\t${1:pass}\nexcept ${2:Exception} as e:\n\t${0:print(e)}', t("异常处理")], ['class', 'class ${1:ClassName}:\n\tdef __init__(self, ${2:args}):\n\t\t${0:pass}', t("定义类")], ['len', 'len(${1:items})', t("获取长度")], ['range', 'range(${1:stop})', t("生成整数序列")], ['sum', 'sum(${1:items})', t("求和")], ['enumerate', 'enumerate(${1:items})', t("索引和值")], ['with', 'with open("${1:file.txt}", "${2:r}", encoding="utf-8") as f:\n\t${0:content = f.read()}', t("安全打开文件")]],
    c: [['printf', 'printf("${1:%d}\\n", ${2:value});', t("格式化输出")], ['scanf', 'scanf("${1:%d}", &${2:value});', t("读取输入")], ['for', 'for (int ${1:i} = 0; $1 < ${2:n}; $1++) {\n\t${0}\n}', t("for 循环")], ['if', 'if (${1:condition}) {\n\t${0}\n}', t("条件判断")], ['main', '#include <stdio.h>\n\nint main(void) {\n\t${0}\n\treturn 0;\n}', t("C 程序入口")], ['while', 'while (${1:condition}) {\n\t${0}\n}', t("while 循环")], ['include', '#include <${1:stdio.h}>', t("包含头文件")]],
    cpp: [['cout', 'std::cout << ${1:value} << std::endl;', t("输出到终端")], ['cin', 'std::cin >> ${1:value};', t("读取输入")], ['for', 'for (int ${1:i} = 0; $1 < ${2:n}; ++$1) {\n\t${0}\n}', t("for 循环")], ['foreach', 'for (const auto& ${1:item} : ${2:items}) {\n\t${0}\n}', t("遍历容器")], ['main', '#include <iostream>\n\nint main() {\n\t${0}\n\treturn 0;\n}', t("C++ 程序入口")], ['vector', 'std::vector<${1:int}> ${2:items};', t("动态数组")], ['if', 'if (${1:condition}) {\n\t${0}\n}', t("条件判断")], ['include', '#include <${1:iostream}>', t("包含头文件")]],
};
const keywords: Record<string, string[]> = { python: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield int float str list dict set tuple bool sorted reversed zip max min abs round open isinstance'.split(' '), c: 'auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while'.split(' '), cpp: 'alignas auto bool break case catch char class const constexpr continue default delete do double else enum explicit extern false float for friend if inline int long namespace new noexcept nullptr operator private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while std string vector map cout cin endl'.split(' ') };
const CodeEditor = forwardRef<any, {
    file: OpenFile | undefined;
    onChange: (value: string) => void;
    onPosition: (pos: any) => void;
    onComplete: () => void;
    onSave: () => void;
    onRun: () => void;
    onQuickOpen: () => void;
    workspace: string;
    files: OpenFile[];
    onDefinition: (path: string, line: number) => void;
    onDiagnostics: (path: string, markers: any[]) => void;
    onServices: (value: any) => void;
}>(function CodeEditor({ file, onChange, onPosition, onComplete, onSave, onRun, onQuickOpen, workspace, files, onDefinition, onDiagnostics, onServices }, ref) {
    const container = useRef<HTMLDivElement>(null);
    const instance = useRef<any>(null);
    const monacoRef = useRef<any>(null);
    const callbacks = useRef({ onChange, onPosition, onComplete, onSave, onRun, onQuickOpen, workspace, files, onDefinition, onDiagnostics, onServices });
    const fileRef = useRef(file);
    const suppress = useRef(false);
    const pending = useRef<any>(null);
    const views = useRef(new Map());
    const [ready, setReady] = useState(false);
    const [error, setError] = useState('');
    callbacks.current = { onChange, onPosition, onComplete, onSave, onRun, onQuickOpen, workspace, files, onDefinition, onDiagnostics, onServices };
    fileRef.current = file;
    useEffect(() => {
        let canceled = false;
        const disposables: any[] = [];
        Promise.all([import('monaco-editor'), import('monaco-editor/editor/editor.worker.js?worker'), import('monaco-editor/language/json/json.worker.js?worker'), import('monaco-editor/language/css/css.worker.js?worker'), import('monaco-editor/language/html/html.worker.js?worker'), import('monaco-editor/language/typescript/ts.worker.js?worker')]).then(([monaco, worker, jsonWorker, cssWorker, htmlWorker, tsWorker]) => {
            if (canceled)
                return;
            (globalThis as any).MonacoEnvironment = { getWorker: (_id: string, label: string) => new ({ json: jsonWorker.default, css: cssWorker.default, scss: cssWorker.default, less: cssWorker.default, html: htmlWorker.default, handlebars: htmlWorker.default, razor: htmlWorker.default, typescript: tsWorker.default, javascript: tsWorker.default }[label] || worker.default)() };
            monacoRef.current = monaco;
            monaco.editor.defineTheme('studio', { base: 'vs-dark', inherit: true, rules: [{ token: 'comment', foreground: '758395' }, { token: 'keyword', foreground: 'C792EA' }, { token: 'string', foreground: 'C3DC92' }, { token: 'number', foreground: 'F3BC82' }], colors: { 'editor.background': '#15191f', 'editor.foreground': '#d7dfea', 'editorLineNumber.foreground': '#526075', 'editorLineNumber.activeForeground': '#b8c8dc', 'editor.lineHighlightBackground': '#1c232c', 'editorCursor.foreground': '#68d5bd', 'editor.selectionBackground': '#274354', 'editorIndentGuide.background1': '#26303c', 'editorWidget.background': '#1c242e', 'editorSuggestWidget.background': '#1c242e', 'editorSuggestWidget.border': '#354354', 'editorGhostText.foreground': '#6eaa9e' } });
            const editor = monaco.editor.create(container.current!, { theme: 'studio', editContext: false, automaticLayout: true, fontSize: 14, fontFamily: 'Consolas, "Cascadia Code", monospace', lineHeight: 23, minimap: { enabled: true, scale: 1, maxColumn: 80 }, padding: { top: 20, bottom: 20 }, scrollBeyondLastLine: false, smoothScrolling: true, renderLineHighlight: 'all', bracketPairColorization: { enabled: true }, tabSize: 4, insertSpaces: true, wordWrap: 'off', ariaLabel: t("代码编辑器"), inlineSuggest: { enabled: true }, suggest: { preview: false }, quickSuggestions: true });
            instance.current = editor;
            disposables.push(editor.onDidChangeModelContent(() => { if (!suppress.current)
                callbacks.current.onChange(editor.getValue()); }));
            disposables.push(editor.onDidChangeCursorPosition((e: any) => callbacks.current.onPosition(e.position)));
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.Space, () => callbacks.current.onComplete());
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave());
            editor.addCommand(monaco.KeyCode.F5, () => callbacks.current.onRun());
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => callbacks.current.onQuickOpen());
            for (const lang of ['python', 'c', 'cpp']) {
                disposables.push(monaco.languages.registerCompletionItemProvider(lang, { provideCompletionItems(model: any, position: any) {
                        const word = model.getWordUntilPosition(position);
                        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
                        const suggestions = (snippets[lang] || []).map(([label, insertText, detail], i) => ({ label, insertText, detail: tr `${detail} · 代码片段`, kind: monaco.languages.CompletionItemKind.Snippet, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range, sortText: `0${i.toString().padStart(2, '0')}` }));
                        const existing = new Set(suggestions.map(x => x.label));
                        for (const label of new Set([...(keywords[lang] || []), ...(model.getValue().match(/\b[A-Za-z_]\w*\b/g) || [])]))
                            if (!existing.has(label))
                                suggestions.push({ label, insertText: label, detail: t("关键字 / 当前文件符号"), kind: monaco.languages.CompletionItemKind.Variable, range, sortText: `1${label}` } as any);
                        return { suggestions };
                    } }));
                disposables.push(monaco.languages.registerInlineCompletionsProvider(lang, { provideInlineCompletions(model: any, position: any) { const value = pending.current; if (value && value.uri === model.uri.toString() && value.version === model.getVersionId() && value.position.lineNumber === position.lineNumber && value.position.column === position.column)
                        return { items: [{ insertText: value.text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] }; return { items: [] }; }, disposeInlineCompletions() { } }));
            }
            const service = attachLanguageServices(monaco, editor, api, { files: () => callbacks.current.files, workspace: () => callbacks.current.workspace, definition: (path: string, line: number) => callbacks.current.onDefinition(path, line), diagnostics: (path: string, markers: any[]) => callbacks.current.onDiagnostics(path, markers), status: (value: any) => callbacks.current.onServices(value) });
            disposables.push(service);
            setReady(true);
        }).catch(e => setError(String(e.message)));
        return () => { canceled = true; disposables.forEach(d => d.dispose()); instance.current?.getModel()?.dispose(); instance.current?.dispose(); monacoRef.current?.editor.getModels().forEach((m: any) => m.dispose()); };
    }, []);
    useEffect(() => {
        if (!ready || !file)
            return;
        const monaco = monacoRef.current;
        const editor = instance.current;
        const uri = monaco.Uri.parse(`inmemory://workspace/${encodeURIComponent(file.path)}`);
        let model = monaco.editor.getModel(uri);
        suppress.current = true;
        if (!model)
            model = monaco.editor.createModel(file.content, language(file.path), uri);
        if (editor.getModel() !== model) {
            if (editor.getModel())
                views.current.set(editor.getModel().uri.toString(), editor.saveViewState());
            editor.setModel(model);
            editor.restoreViewState(views.current.get(uri.toString()) || null);
            pending.current = null;
        }
        if (model.getValue() !== file.content)
            model.setValue(file.content);
        suppress.current = false;
    }, [ready, file?.path, file?.content]);
    useImperativeHandle(ref, () => ({
        context() { const editor = instance.current; const model = editor?.getModel(); if (!model)
            return null; const position = editor.getPosition(); return { position, version: model.getVersionId(), uri: model.uri.toString(), selection: model.getValueInRange(editor.getSelection()), prefix: model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column }), suffix: model.getValue().slice(model.getOffsetAt(position)) }; },
        showCompletion(text: string, context: any) { if (instance.current?.getModel()?.getVersionId() !== context.version || instance.current.getModel().uri.toString() !== context.uri)
            return false; pending.current = { ...context, text }; instance.current.focus(); instance.current.getAction('editor.action.inlineSuggest.trigger')?.run(); return true; },
        insert(text: string, context?: any) { const editor = instance.current; const model = editor?.getModel(); if (!model)
            return false; if (context && (model.getVersionId() !== context.version || model.uri.toString() !== context.uri))
            return false; const pos = context?.position || editor.getPosition(); const range = context ? new monacoRef.current.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column) : editor.getSelection(); editor.pushUndoStop(); editor.executeEdits('ai-insert', [{ range, text, forceMoveMarkers: true }]); editor.pushUndoStop(); pending.current = null; editor.focus(); return true; },
        hideCompletion() { pending.current = null; instance.current?.getAction('editor.action.inlineSuggest.hide')?.run(); },
        markers(filePath: string, markers: any[]) { const m = monacoRef.current; if (!m)
            return; const model = m.editor.getModel(m.Uri.parse(`inmemory://workspace/${encodeURIComponent(filePath)}`)); if (model)
            m.editor.setModelMarkers(model, 'local-runner', markers.map(x => ({ startLineNumber: x.line, endLineNumber: x.line, startColumn: x.column, endColumn: x.column + 1, message: x.message, severity: x.severity === 'error' ? m.MarkerSeverity.Error : m.MarkerSeverity.Warning }))); },
        find() { instance.current?.getAction('actions.find')?.run(); }, focus() { instance.current?.focus(); },
        goToLine(filePath: string, line: number) { const editor = instance.current; const m = monacoRef.current; if (!editor?.getModel() || editor.getModel().uri.toString() !== m.Uri.parse(`inmemory://workspace/${encodeURIComponent(filePath)}`).toString())
            return; const target = Math.min(editor.getModel().getLineCount(), Math.max(1, line)); editor.revealLineInCenter(target); editor.setPosition({ lineNumber: target, column: 1 }); editor.focus(); },
        mentorEvidence(filePath: string, evidence: any[]) { const editor = instance.current; const m = monacoRef.current; if (!editor?.getModel() || !m)
            return; if (!editor.__mentorDecorations)
            editor.__mentorDecorations = editor.createDecorationsCollection(); const model = editor.getModel(); const valid = evidence.filter(item => item.path === filePath && item.line <= model.getLineCount()); editor.__mentorDecorations.set(valid.map(item => { const column = model.getLineMaxColumn(item.line); return { range: new m.Range(item.line, 1, item.line, column), options: { isWholeLine: true, showIfCollapsed: true, className: 'mentor-evidence-line', after: { content: tr `  ◀ 导师：${item.message.slice(0, 45)}`, inlineClassName: 'mentor-inline-hint' } } }; })); },
    }), [ready]);
    return <div className="code-area"><div ref={container} className="monaco-host"/>{!ready && <div className="editor-loading">{error ? tr `编辑器加载失败：${error}` : t("正在打开本地编辑器…")}</div>}</div>;
});
function Tree({ entries, active, onOpen, filter = '', depth = 0 }: any) {
    const [closed, setClosed] = useState<Set<string>>(new Set());
    return entries.map((item: any) => item.type === 'directory' ? <React.Fragment key={item.path}><button className="tree-row directory" style={{ paddingLeft: 12 + depth * 14 }} onClick={() => setClosed(old => { const next = new Set(old); next.has(item.path) ? next.delete(item.path) : next.add(item.path); return next; })}>{closed.has(item.path) ? <ChevronRight size={13}/> : <ChevronDown size={13}/>}<span>{item.name}</span></button>{!closed.has(item.path) && <Tree entries={item.children} active={active} onOpen={onOpen} filter={filter} depth={depth + 1}/>}</React.Fragment> : (!filter || item.path.toLowerCase().includes(filter.toLowerCase())) && <button title={item.path} key={item.path} className={`tree-row ${active === item.path ? 'selected' : ''}`} style={{ paddingLeft: 25 + depth * 14 }} onClick={() => onOpen(item.path)}><FileIcon file={item.name}/><span>{item.name}</span></button>);
}
function flatten(entries: any[]): any[] { return entries.flatMap(x => x.type === 'file' ? [x] : flatten(x.children)); }
function Markdown({ content, onInsert, onToast }: {
    content: string;
    onInsert: (code: string) => void;
    onToast: (text: string) => void;
}) {
    return <>{content.split(/(```[\s\S]*?```)/g).map((part, i) => part.startsWith('```') ? <div className="chat-code" key={i}><div><span>{part.match(/^```([^\n]*)/)?.[1] || 'code'}</span><button title={t("复制代码")} onClick={() => navigator.clipboard.writeText(part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')).then(() => onToast(t("已复制代码")))}><Copy size={13}/></button><button title={t("插入光标位置；可用 Ctrl+Z 撤销")} onClick={() => onInsert(part.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, ''))}><ArrowDownToLine size={13}/></button></div><pre>{part.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '')}</pre></div> : <div className="message-text" key={i}>{part.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, j) => p.startsWith('**') ? <strong key={j}>{p.slice(2, -2)}</strong> : p.startsWith('`') ? <code key={j}>{p.slice(1, -1)}</code> : p)}</div>)}</>;
}
function SettingsModal({ initial, tools, beforeRestore, initialTab = 'ai', onClose, onSaved, toast }: any) {
    const [form, setForm] = useState({ ...initial, key: '', clearKey: false, tools: { ...initial.tools } });
    const [tab, setTab] = useState(initialTab);
    const [busy, setBusy] = useState('');
    const [result, setResult] = useState('');
    const [localTools, setLocalTools] = useState(tools);
    const update = (name: string, value: any) => { setForm((old: any) => ({ ...old, [name]: value })); setResult(''); };
    const presets: any = { custom: { baseUrl: '', model: '', protocol: 'chat', anonymous: false }, deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', protocol: 'chat', anonymous: false }, ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: '', protocol: 'chat', anonymous: true }, anthropic: { baseUrl: '', model: '', protocol: 'anthropic', anonymous: false } };
    async function save(test = false) { setBusy(test ? 'test' : 'save'); setResult(''); try {
        const data = await api('settings', form);
        setLocalTools(data.tools);
        onSaved(data);
        setForm((old: any) => ({ ...old, ...data.settings, key: '', clearKey: false }));
        if (test) {
            await api('ai', { kind: 'test' });
            setResult(t("连接成功，模型已返回文本。"));
        }
        else
            toast(t("设置已保存到本机"));
    }
    catch (e: any) {
        setResult(e.message);
    }
    finally {
        setBusy('');
    } }
    return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}><section className="settings-modal" role="dialog" aria-modal="true" aria-label={t("工作台设置")}><div className="modal-title"><div><Settings size={18}/><h2>{t("工作台设置")}</h2></div><button className="icon-button" aria-label={t("关闭设置")} onClick={onClose}><X size={18}/></button></div><div className="settings-tabs"><button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}><Plug size={15}/>{t("AI 服务")}</button><button className={tab === 'runtime' ? 'active' : ''} onClick={() => setTab('runtime')}><Terminal size={15}/>{t("运行环境")}</button><button className={tab === 'backup' ? 'active' : ''} onClick={() => setTab('backup')}>{t("升级与备份")}</button></div><div className="settings-body">{tab === 'backup' ? <BackupSettings api={api} toast={toast} beforeRestore={beforeRestore}/> : tab === 'ai' ? <><div className="settings-intro"><span className="round-icon"><Sparkles size={19}/></span><div><h3>{t("连接你自己的 AI")}</h3><p>{t("填写服务商提供的地址、模型和密钥。补全与导师共用此设置。")}</p></div></div><label>{t("服务类型")}<select aria-label={t("服务类型")} value={form.provider} onChange={e => { const p = presets[e.target.value]; setForm((old: any) => ({ ...old, ...p, provider: e.target.value, key: '', clearKey: true, hasKey: false })); setResult(''); }}><option value="custom">{t("自定义中转站 / 兼容接口")}</option><option value="deepseek">{t("DeepSeek 官方")}</option><option value="ollama">{t("Ollama 本地模型")}</option><option value="anthropic">{t("Anthropic 兼容接口")}</option></select></label><div className="form-grid"><label>{t("接口协议")}<select aria-label={t("接口协议")} value={form.protocol} onChange={e => update('protocol', e.target.value)}><option value="chat">{t("Chat Completions（常见中转站 / DeepSeek）")}</option><option value="responses">Responses</option><option value="anthropic">Anthropic Messages</option></select></label><label>{t("模型名称")}<input aria-label={t("模型名称")} value={form.model} placeholder={form.provider === 'deepseek' ? 'deepseek-flash' : t("服务商提供的完整模型名")} onChange={e => update('model', e.target.value)}/></label></div><label>{t("API 地址")}<input aria-label={t("API 地址")} value={form.baseUrl} placeholder={t("https://你的中转站地址/v1")} onChange={e => update('baseUrl', e.target.value)}/><small>{t("支持基础地址或完整接口地址。中转站需要 /v1 时，请一并填写。")}</small></label><label>{t("API 密钥")}<span className="optional">{form.hasKey && !form.clearKey ? t("已保存；留空则保留") : t("仅保存在本机")}</span><div className="key-input"><input aria-label={t("API 密钥")} type="password" value={form.key} autoComplete="off" placeholder={form.hasKey && !form.clearKey ? t("•••••••• 已加密保存") : t("在这里粘贴密钥")} onChange={e => update('key', e.target.value)}/>{form.hasKey && <button title={t("清除已保存密钥")} onClick={() => setForm((old: any) => ({ ...old, clearKey: true, key: '', hasKey: false }))}><Trash2 size={15}/></button>}</div></label><label className="checkbox-label"><input type="checkbox" checked={form.streaming !== false} onChange={e => update('streaming', e.target.checked)}/>{t("流式回答：边生成边显示")}</label><label className="checkbox-label"><input type="checkbox" checked={form.anonymous} onChange={e => update('anonymous', e.target.checked)}/>{t("此接口无需密钥（例如本机 Ollama）")}</label><div className="security-note"><ShieldCheck size={16}/><span>{t("密钥使用当前 Windows 账户加密保存。修改服务地址后，请重新填写密钥。开始实时导师任务后，会按检查设置自动发送相关打开文件、选中代码和运行输出；暂停导师或切换手动模式可控制自动发送。对话、补全和测试连接也会调用所填服务，服务商可能收费。")}</span></div></> : <><div className="settings-intro"><span className="round-icon"><Terminal size={19}/></span><div><h3>{t("用电脑上的工具运行代码")}</h3><p>{t("安装包仅内置 Node.js。Python 和 C/C++ 工具需另行安装；留空时自动检测，也可填写程序的完整路径。")}</p></div></div>{[['python', t("Python 解释器")], ['c', t("C 编译器（GCC / Clang）")], ['cpp', t("C++ 编译器（G++ / Clang++）")]].map(([id, label]) => <label key={id}>{label}<input aria-label={label} value={form.tools[id] || ''} placeholder={localTools[id]?.path || t("例如 C:\\工具目录\\程序.exe")} onChange={e => setForm((old: any) => ({ ...old, tools: { ...old.tools, [id]: e.target.value } }))}/><small className={localTools[id]?.available ? 'success-text' : ''}>{localTools[id]?.available ? '✓ ' : '○ '}{t(localTools[id]?.version)}</small></label>)}<label>{t("单次运行时间上限（秒）")}<input aria-label={t("运行时间上限")} type="number" min="10" max="600" value={form.timeout} onChange={e => update('timeout', e.target.value)}/><small>{t("C/C++ 单文件编译上限 30 秒；程序支持终端输入与手动停止。")}</small></label><div className="security-note"><FolderOpen size={16}/><span>{t("工作区：")}{initial.workspace}</span></div></>}{result && <div className={`connection-result ${result.startsWith(t("连接成功")) ? 'ok' : 'error'}`}>{result.startsWith(t("连接成功")) ? <CheckCircle2 size={16}/> : <AlertCircle size={16}/>}<span>{result}</span></div>}</div><div className="modal-footer"><span>{tab === 'ai' ? t("测试连接会发送一次简短 API 请求。") : t("修改路径后，保存会重新检测工具。")}</span>{tab === 'ai' && <button className="secondary-button" disabled={!!busy} onClick={() => save(true)}>{busy === 'test' ? <RotateCw size={14} className="spin"/> : <Plug size={14}/>}{t("测试连接")}</button>}<button className="primary-button" disabled={!!busy} onClick={() => save()}>{busy === 'save' ? <RotateCw size={14} className="spin"/> : <Check size={14}/>}{t("保存设置")}</button></div></section></div>;
}
const practice = (): any => ({
    python: [{ title: t("写一个账单求和函数"), target: t("完成 calculate_total，让三笔支出的总额输出 78.5。"), hint: t("遍历 amounts，把每个金额加到 total，再返回 total。也可以试试 sum。"), path: 'practice.py', code: '# 练习 01：计算支出总额\n\ndef calculate_total(amounts):\n    total = 0\n    # TODO: 累加每一笔支出\n    return total\n\n\nexpenses = [18.5, 32.0, 28.0]\nprint("总支出：", calculate_total(expenses))\n' }, { title: t("筛选超过预算的支出"), target: t("实现 over_budget，返回金额大于 limit 的项目列表。"), hint: t("先用空列表保存结果，在循环中判断金额，再 append。"), path: 'practice_filter.py', code: 'def over_budget(expenses, limit):\n    # TODO: 返回金额大于 limit 的项目\n    return []\n\nprint(over_budget([18.5, 32.0, 28.0], 25))\n# 预期：[32.0, 28.0]\n' }],
    c: [{ title: t("计算两个整数的和"), target: t("补全 add 函数，运行后输出 42。"), hint: t("返回 a + b。编译器的警告也会显示在终端。"), path: 'practice.c', code: '#include <stdio.h>\n\nint add(int a, int b) {\n    /* TODO: 返回两个整数的和 */\n    return 0;\n}\n\nint main(void) {\n    printf("Result: %d\\n", add(18, 24));\n    return 0;\n}\n' }, { title: t("循环求和"), target: t("写出从 1 到 n 的求和函数，n=10 时输出 55。"), hint: t("用 for 循环从 1 到 n，累加到 sum。"), path: 'practice_loop.c', code: '#include <stdio.h>\n\nint sum_to(int n) {\n    int sum = 0;\n    /* TODO */\n    return sum;\n}\n\nint main(void) {\n    printf("%d\\n", sum_to(10));\n    return 0;\n}\n' }],
    cpp: [{ title: t("统计一组整数的总和"), target: t("完成 sum_numbers，运行后输出 60。"), hint: t("用范围 for 遍历 numbers，把值累加到 total。"), path: 'practice.cpp', code: '#include <iostream>\n#include <vector>\n\nint sum_numbers(const std::vector<int>& numbers) {\n    int total = 0;\n    // TODO: 累加每个数字\n    return total;\n}\n\nint main() {\n    std::cout << sum_numbers({10, 20, 30}) << std::endl;\n    return 0;\n}\n' }, { title: t("寻找最大值"), target: t("实现 max_number，让程序输出 32。"), hint: t("从第一个值开始比较；注意空容器应该怎样处理。"), path: 'practice_max.cpp', code: '#include <iostream>\n#include <vector>\n\nint max_number(const std::vector<int>& numbers) {\n    // TODO: 返回最大的整数，空列表返回 0\n    return 0;\n}\n\nint main() {\n    std::cout << max_number({18, 32, 28}) << std::endl;\n    return 0;\n}\n' }],
});
function App() {
    const locale = useLocale();
    const [state, setState] = useState<any>(null);
    const [files, setFiles] = useState<OpenFile[]>([]);
    const [active, setActive] = useState('');
    const [activity, setActivity] = useState('files');
    const [sidebar, setSidebar] = useState(true);
    const [aiVisible, setAiVisible] = useState(true);
    const [terminalVisible, setTerminalVisible] = useState(true);
    const [terminalHeight, setTerminalHeight] = useState(225);
    const [position, setPosition] = useState({ lineNumber: 1, column: 1 });
    const [toast, setToast] = useState('');
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [dialog, setDialog] = useState('');
    const [dialogValue, setDialogValue] = useState('');
    const [dialogBusy, setDialogBusy] = useState(false);
    const [filter, setFilter] = useState('');
    const [saving, setSaving] = useState(false);
    const [run, setRun] = useState<any>(null);
    const [output, setOutput] = useState<Array<{
        text: string;
        channel: string;
    }>>([]);
    const [input, setInput] = useState('');
    const [args, setArgs] = useState('');
    const [messages, setMessages] = useState<Message[]>([]);
    const [prompt, setPrompt] = useState('');
    const [aiBusy, setAiBusy] = useState(false);
    const [includeContext, setIncludeContext] = useState(true);
    const [aiTab, setAiTab] = useState('mentor');
    const [lesson, setLesson] = useState(0);
    const [hint, setHint] = useState(false);
    const [completion, setCompletion] = useState<any>(null);
    const [completionBusy, setCompletionBusy] = useState(false);
    const [markers, setMarkers] = useState<any[]>([]);
    const [connection, setConnection] = useState(true);
    const [settingsTab, setSettingsTab] = useState('ai');
    const chatJob = useRef<AbortController | null>(null);
    const retryMessages = useRef<Message[]>([]);
    const [semanticMarkers, setSemanticMarkers] = useState<Record<string, any[]>>({});
    const [services, setServices] = useState<any>({});
    const [problemsOpen, setProblemsOpen] = useState(false);
    const problems = [...markers.map(item => ({ ...item, path: run?.path || active })), ...Object.entries(semanticMarkers).flatMap(([path, values]) => values.map(item => ({ ...item, path })))];
    function beforeRestore() { if (files.some(file => file.content !== file.saved)) {
        notify(t("请先保存打开的修改，再恢复备份。"));
        return false;
    } return true; }
    useEffect(() => () => { chatJob.current?.abort(); }, []);
    const [projectOpen, setProjectOpen] = useState(false);
    async function openProject() {
        try {
            const data = await api('project');
            setState((old: any) => ({ ...old, ...data }));
            setProjectOpen(true);
        }
        catch (error: any) {
            notify(error.message);
        }
    }
    function projectSaved(data: any) {
        window.dispatchEvent(new Event('studio:language-reset'));
        setState((old: any) => ({ ...old, ...data }));
        const content = JSON.stringify(data.project.config, null, 2) + '\n';
        setFiles(old => old.map(file => file.path === '.codestudio.json' && file.content === file.saved ? { ...file, content, saved: content } : file));
    }
    const [runtimeNoticeDismissed, setRuntimeNoticeDismissed] = useState(() => { try {
        return localStorage.getItem('studio-runtime-notice-dismissed:v1') === '1';
    }
    catch {
        return false;
    } });
    function openSettings(tab = 'ai') { setSettingsTab(tab); setSettingsOpen(true); }
    function dismissRuntimeNotice() { setRuntimeNoticeDismissed(true); try {
        localStorage.setItem('studio-runtime-notice-dismissed:v1', '1');
    }
    catch { } }
    const runtimeLanguages = [['python', 'Python'], ['c', 'C'], ['cpp', 'C++']];
    const missingRuntimeTools = state ? runtimeLanguages.filter(([id]) => !state.tools?.[id]?.available) : [];
    const runtimeStatus = !state ? t("检测中") : missingRuntimeTools.length === 0 ? t("已就绪") : missingRuntimeTools.length === runtimeLanguages.length ? t("需要配置") : t("部分缺失");
    const editorRef = useRef<any>(null);
    const terminalEnd = useRef<HTMLDivElement>(null);
    const chatEnd = useRef<HTMLDivElement>(null);
    const toastTimer = useRef<any>(null);
    const drafts = useRef(new Map<string, string>());
    const runRef = useRef<any>(null);
    const current = files.find(x => x.path === active);
    const lang = language(active);
    const isRunning = run && run.phase !== 'finished';
    const aiReady = state?.settings?.baseUrl && state?.settings?.model && (state?.settings?.hasKey || state?.settings?.anonymous);
    function notify(text: string) { setToast(t(text)); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 4200); }
    const mentorContext = useMemo(() => ({ activePath: active, language: lang, files: files.map(file => ({ path: file.path, code: file.content })), selection: editorRef.current?.context()?.selection || '', run: run ? { ...run, output: output.map(item => item.text).join('') } : null }), [active, lang, files, run, output, position]);
    const mentorState = useTaskMentor({ workspace: state?.settings.workspace, context: mentorContext, aiReady, connection, otherBusy: aiBusy || completionBusy, configure: () => openSettings(), toast: notify });
    useEffect(() => { editorRef.current?.mentorEvidence(active, mentorState.fresh ? mentorState.session?.review?.evidence || [] : []); }, [active, current?.content, mentorState.session, mentorState.fresh]);
    async function focusMentorLine(filePath: string, line: number) { await openFile(filePath); window.setTimeout(() => editorRef.current?.goToLine(filePath, line), 100); }
    useEffect(() => { api('state').then(data => { setState(data); setLocale(data.settings.locale); if (data.run) {
        setRun(data.run);
        if (data.run.output)
            setOutput([{ text: data.run.output, channel: 'stdout' }]);
    } const list = flatten(data.tree.entries); if (list.length)
        void openFile(list.find(x => x.path === 'main.py')?.path || list.find(x => x.path.endsWith('.py'))?.path || list[0].path, data.settings.workspace); }).catch(e => notify(e.message)); }, []);
    useEffect(() => {
        const events = new EventSource(`/api/events?token=${token}`);
        events.onopen = () => setConnection(true);
        events.onerror = () => setConnection(false);
        events.onmessage = e => {
            const event = JSON.parse(e.data);
            if (event.type === 'language-diagnostics')
                window.dispatchEvent(new CustomEvent('studio:language-diagnostics', { detail: event }));
            if (event.type === 'mentor')
                window.dispatchEvent(new CustomEvent('studio:mentor', { detail: event }));
            if (event.type === 'start') {
                setRun({ ...event, started: Date.now() });
                runRef.current = event;
                setOutput([]);
                setMarkers([]);
                setTerminalVisible(true);
            }
            if (event.type === 'output')
                setOutput(old => [...old.slice(-2000), { text: event.text, channel: event.channel }]);
            if (event.type === 'phase')
                setRun((old: any) => ({ ...old, phase: event.phase }));
            if (event.type === 'finish') {
                setRun((old: any) => ({ ...old, ...event, phase: 'finished' }));
                runRef.current = { ...event, phase: 'finished' };
            }
            if (event.type === 'diagnostics') {
                setMarkers(event.markers);
                editorRef.current?.markers(event.path, event.markers);
            }
        };
        return () => events.close();
    }, []);
    useEffect(() => { terminalEnd.current?.scrollIntoView({ block: 'nearest' }); }, [output]);
    useEffect(() => { chatEnd.current?.scrollIntoView({ block: 'nearest' }); }, [messages, aiBusy]);
    useEffect(() => { setCompletion(null); editorRef.current?.hideCompletion(); }, [active]);
    useEffect(() => { setLesson(0); setHint(false); }, [lang]);
    useEffect(() => {
        const handle = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            void saveFile();
        } if (e.key === 'F5') {
            e.preventDefault();
            void runFile();
        } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
            e.preventDefault();
            setDialog('quick');
            setDialogValue('');
        } if (e.key === 'Escape') {
            setCompletion(null);
            editorRef.current?.hideCompletion();
            if (dialog)
                setDialog('');
        } };
        window.addEventListener('keydown', handle);
        return () => window.removeEventListener('keydown', handle);
    });
    useEffect(() => { const handler = (e: BeforeUnloadEvent) => { if (files.some(x => x.content !== x.saved)) {
        e.preventDefault();
        e.returnValue = '';
    } }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, [files]);
    async function refresh() { try {
        const data = await api('state');
        setState(data);
    }
    catch (e: any) {
        notify(e.message);
    } }
    async function openFile(file: string, root?: string) {
        if (!root && files.some(x => x.path === file)) {
            setActive(file);
            setDialog('');
            return;
        }
        try {
            const result = await api(`files?path=${encodeURIComponent(file)}`);
            const workspace = root || state?.settings.workspace;
            const key = `${workspace}|${file}`;
            let content = result.content;
            try {
                const draft = localStorage.getItem(`studio-draft:${key}`);
                if (draft !== null && draft !== result.content) {
                    content = draft;
                    notify(t("已恢复上次未保存的草稿；Ctrl+S 保存到文件。"));
                }
            }
            catch { }
            drafts.current.set(file, content);
            setFiles(old => [...old.filter(x => x.path !== file), { path: file, content, saved: result.content }]);
            setActive(file);
            setDialog('');
        }
        catch (e: any) {
            notify(e.message);
        }
    }
    function changeCode(value: string) { const target = active; setFiles(old => old.map(x => x.path === target ? { ...x, content: value } : x)); drafts.current.set(target, value); try {
        localStorage.setItem(`studio-draft:${state?.settings.workspace}|${target}`, value);
    }
    catch { } if (completion) {
        setCompletion(null);
        editorRef.current?.hideCompletion();
    } }
    async function saveFile(file = current) {
        if (!file)
            return false;
        setSaving(true);
        try {
            await api('files', { path: file.path, content: file.content }); if (file.path === '.codestudio.json') window.dispatchEvent(new Event('studio:language-reset'));
            setFiles(old => old.map(x => x.path === file.path ? { ...x, saved: file.content } : x));
            try {
                localStorage.removeItem(`studio-draft:${state?.settings.workspace}|${file.path}`);
            }
            catch { }
            return true;
        }
        catch (e: any) {
            notify(e.message);
            return false;
        }
        finally {
            setSaving(false);
        }
    }
    async function runFile() {
        if (!current || isRunning)
            return;
        if (!connection) {
            notify(t("本地服务连接已断开，请刷新页面或重新启动工作台。"));
            return;
        }
        for (const file of files.filter(file => file.content !== file.saved || file.path === active))
            if (!await saveFile(file))
                return;
        setTerminalVisible(true);
        try {
            const project = await api('project');
            setState((old: any) => ({ ...old, ...project }));
            if (project.project.error) {
                setProjectOpen(true);
                notify(project.project.error);
                return;
            }
            const runtimeTool = { python: 'python', c: 'c', cpp: 'cpp' }[lang];
            if (runtimeTool && !project.tools?.[runtimeTool]?.available) {
                if (runtimeTool === 'python' && project.tools.python.environment === 'venv')
                    setProjectOpen(true);
                else
                    openSettings('runtime');
                notify(langLabel(lang) + t(" 运行工具未就绪，请检查运行环境或项目设置。"));
                return;
            }
            await api('run', { path: active, args });
        }
        catch (error: any) {
            notify(error.message);
        }
    }
    async function stopRun() { try {
        await api('stop', {});
    }
    catch (e: any) {
        notify(e.message);
    } }
    async function sendInput(e: React.FormEvent) { e.preventDefault(); try {
        await api('input', { text: input + '\n' });
        setInput('');
    }
    catch (e: any) {
        notify(e.message);
    } }
    function closeFile(file: OpenFile) { if (file.content !== file.saved && !window.confirm(tr `关闭 ${basename(file.path)}？未保存的内容会保留为本机草稿。`))
        return; const next = files.filter(x => x.path !== file.path); setFiles(next); if (active === file.path)
        setActive(next[0]?.path || ''); }
    async function sendMessage(text = prompt, retry = false) {
        if ((!text.trim() && !retry) || aiBusy)
            return;
        if (!aiReady) {
            setPrompt(text);
            openSettings();
            return;
        }
        const next: Message[] = retry ? retryMessages.current : [...messages.filter(m => !m.error && !m.incomplete), { role: 'user', content: text.trim() }];
        if (!next.length)
            return;
        retryMessages.current = next;
        setAiVisible(true);
        setAiTab('chat');
        setPrompt('');
        setAiBusy(true);
        const job = new AbortController();
        chatJob.current = job;
        let received = '';
        setMessages([...next, { role: 'assistant', content: '' }]);
        const data = { kind: 'chat', messages: next, taskContext: mentorState.session ? { task: mentorState.session.task, step: mentorState.session.steps[mentorState.session.currentStep], progress: mentorState.session.currentStep + 1 } : undefined, ...(includeContext ? { path: active, language: lang, code: current?.content || '', selection: editorRef.current?.context()?.selection || '', output: output.map(x => x.text).join('') } : {}) };
        try {
            await streamChat(data, token, job.signal, delta => { received += delta; if (chatJob.current === job)
                setMessages([...next, { role: 'assistant', content: received }]); });
        }
        catch (e: any) {
            if (chatJob.current === job)
                setMessages([...next, { role: 'assistant', content: received || (job.signal.aborted ? t("已停止生成。") : ''), incomplete: true }, ...(job.signal.aborted ? [] : [{ role: 'assistant' as const, content: e.message, error: true }])]);
        }
        finally {
            if (chatJob.current === job) {
                chatJob.current = null;
                setAiBusy(false);
            }
        }
    }
    function stopChat() { chatJob.current?.abort(); }
    async function requestCompletion() {
        if (!current || completionBusy)
            return;
        if (!aiReady) {
            openSettings();
            notify(t("先连接 AI 服务，再使用 AI 补全。"));
            return;
        }
        const context = editorRef.current?.context();
        if (!context)
            return;
        setCompletionBusy(true);
        setCompletion(null);
        try {
            const result = await api('ai', { kind: 'complete', path: active, language: lang, prefix: context.prefix, suffix: context.suffix });
            if (editorRef.current?.showCompletion(result.text, context))
                setCompletion({ text: result.text, context });
            else
                notify(t("代码已修改，旧补全已丢弃，请重新请求。"));
        }
        catch (e: any) {
            notify(e.message);
        }
        finally {
            setCompletionBusy(false);
        }
    }
    async function submitDialog(e: React.FormEvent) {
        e.preventDefault();
        if (!dialogValue.trim())
            return;
        setDialogBusy(true);
        try {
            if (dialog === 'folder') {
                if (files.some(x => x.content !== x.saved) && !window.confirm(t("切换文件夹？未保存内容会保留为本机草稿。")))
                    return;
                stopChat(); chatJob.current = null; setAiBusy(false); retryMessages.current = [];
                setSemanticMarkers({});
                setServices({});
                const data = await api('workspace', { path: dialogValue });
                setFiles([]);
                setActive('');
                setState((old: any) => ({ ...old, ...data }));
                setMessages([]);
                setRun(null);
                setOutput([]);
                drafts.current.clear();
                setDialog('');
                const list = flatten(data.tree.entries);
                if (list[0])
                    await openFile(list[0].path, data.settings.workspace);
            }
            else {
                const data = await api('new', { path: dialogValue.trim().replace(/\\/g, '/'), type: dialog === 'directory' ? 'directory' : 'file' });
                setState((old: any) => ({ ...old, tree: data.tree }));
                if (dialog !== 'directory')
                    await openFile(dialogValue.trim().replace(/\\/g, '/'));
                else
                    setDialog('');
            }
        }
        catch (e: any) {
            notify(e.message);
        }
        finally {
            setDialogBusy(false);
        }
    }
    async function startPractice() {
        const item = (practice()[lang] || practice().python)[lesson];
        if (flatten(state.tree.entries).some(x => x.path === item.path)) {
            await openFile(item.path);
            notify(t("已打开已有练习文件。"));
            return;
        }
        try {
            await api('new', { path: item.path, type: 'file' });
            await api('files', { path: item.path, content: item.code });
            await refresh();
            await openFile(item.path);
        }
        catch (e: any) {
            notify(e.message);
        }
    }
    function resizeTerminal(e: React.PointerEvent) { const startY = e.clientY; const height = terminalHeight; const target = e.currentTarget; target.setPointerCapture(e.pointerId); const move = (event: Event) => setTerminalHeight(Math.max(100, Math.min(550, height + startY - (event as PointerEvent).clientY))); const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); }; target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); }
    const selectedPractice = (practice()[lang] || practice().python)[lesson];
    return <div className="app-shell"><header className="topbar"><div className="brand"><span className="brand-icon"><Braces size={20}/></span><strong>Code Studio</strong><span className="brand-tag">v0.3.0 · LOCAL</span></div><nav><button onClick={() => { setDialog('file'); setDialogValue(''); }}>{t("文件")}</button><button onClick={() => editorRef.current?.find()}>{t("查找")}</button><button onClick={() => setTerminalVisible(!terminalVisible)}>{t("终端")}</button><button onClick={() => void openProject()}>{t("项目")}</button><button onClick={() => setDialog('help')}>{t("帮助")}</button></nav><div className="top-workspace"><FolderOpen size={13}/>{state ? basename(state.settings.workspace) : t("正在载入")}<span> / </span>{basename(active)}</div><span className={`local-indicator ${!connection ? 'disconnected' : ''}`}><i />{connection ? t("本机运行") : t("连接断开")}</span><button className="icon-button" title={t("切换 AI 面板")} onClick={() => setAiVisible(!aiVisible)}>{aiVisible ? <PanelRightClose size={17}/> : <PanelRightOpen size={17}/>}</button><select className="locale-switch" aria-label={t("界面语言")} value={locale} onChange={async (e) => { const value = e.target.value; try {
        const saved = await api('settings', { locale: value });
        setState((old: any) => ({ ...old, ...saved }));
        setLocale(value);
    }
    catch (e: any) {
        notify(e.message);
    } }}><option value="zh-CN">{t("中文")}</option><option value="en">English</option></select><button className="icon-button" aria-label={t("打开设置")} onClick={() => openSettings()}><Settings size={17}/></button></header>
  <div className="workspace-layout" style={{ gridTemplateColumns: `48px ${sidebar ? '224px' : '0px'} minmax(0, 1fr) ${aiVisible ? '342px' : '0px'}` }}><aside className="activitybar"><div>{[['files', Files, t("资源管理器")], ['search', Search, t("查找文件")]].map(([id, Icon, label]: any) => <button key={id} aria-label={label} className={activity === id && sidebar ? 'active' : ''} onClick={() => { setSidebar(activity === id ? !sidebar : true); setActivity(id); }}><Icon size={22}/></button>)}<button className={aiVisible ? 'active-ai' : ''} title={t("AI 编程搭档")} onClick={() => setAiVisible(!aiVisible)}><Sparkles size={22}/></button><button title={t("实时导师")} onClick={() => { setAiVisible(true); setAiTab('mentor'); }}><BookOpen size={21}/></button></div><div><button title={t("快捷键")} onClick={() => setDialog('help')}><CircleHelp size={21}/></button><button title={t("设置")} onClick={() => openSettings()}><Settings size={21}/></button><span className="user-avatar">{t("你")}</span></div></aside>
  <aside className={`explorer ${sidebar ? '' : 'hidden-panel'}`}><div className="panel-heading"><span>{activity === 'search' ? t("查找文件") : t("资源管理器")}</span><button className="icon-button" title={t("刷新文件")} onClick={refresh}><RotateCw size={13}/></button></div>{activity === 'search' && <div className="explorer-search"><Search size={14}/><input aria-label={t("查找文件")} placeholder={t("输入文件名…")} value={filter} onChange={e => setFilter(e.target.value)}/></div>}<div className="workspace-heading"><ChevronDown size={13}/><strong>{state ? basename(state.settings.workspace).toUpperCase() : 'WORKSPACE'}</strong><div><button title={t("新建文件")} aria-label={t("新建文件")} onClick={() => { setDialog('file'); setDialogValue(''); }}><FilePlus2 size={13}/></button><button title={t("新建文件夹")} aria-label={t("新建文件夹")} onClick={() => { setDialog('directory'); setDialogValue(''); }}><FolderPlus size={13}/></button></div></div><div className="file-tree">{state && <Tree entries={state.tree.entries} active={active} onOpen={openFile} filter={activity === 'search' ? filter : ''}/>} {state && !state.tree.entries.length && <p className="empty-tree">{t("文件夹为空，点上方 + 新建代码文件。")}</p>}{state?.tree.truncated && <p className="empty-tree">{t("文件较多，仅显示前 4000 项。")}</p>}</div><button className="open-folder" onClick={() => { setDialog('folder'); setDialogValue(state?.settings.workspace || ''); }}><FolderOpen size={15}/>{t("打开文件夹")}</button><button className="project-button" aria-label={t("项目设置")} onClick={() => void openProject()}><Settings size={13}/>{t("项目设置")}<small>{state?.tools.python.environment === 'venv' ? 'venv' : 'F5'}</small></button><div className="runtime-section"><div className="section-label">{t("本地运行环境")}<span className={state && missingRuntimeTools.length ? 'runtime-incomplete' : ''}>{runtimeStatus}</span></div>{[['python', 'Python', 'Py'], ['c', 'C', 'C'], ['cpp', 'C++', 'C++']].map(([id, label, icon]) => <button key={id} onClick={() => openSettings('runtime')} className="runtime-row"><span className={`file-icon ${id}`}>{icon}</span><span>{label}<small>{state?.tools[id]?.available ? (id === 'python' ? state.tools[id].version : 'GCC / Clang') : state ? t("需要配置") : t("检测中…")}</small></span><i className={state?.tools[id]?.available ? 'ready-dot' : 'missing-dot'}/></button>)}<button className="runtime-settings-link" onClick={() => openSettings('runtime')}><Settings size={12}/>{t("配置运行环境")}<ChevronRight size={12}/></button></div><div className="offline-note"><WifiOff size={13}/><span>{t("编辑与运行无需外网")}</span></div></aside>
  <main className="editor-column">{missingRuntimeTools.length > 0 && !runtimeNoticeDismissed && <div className="runtime-notice" role="status"><AlertCircle size={16}/><div><strong>{t("先配置运行工具")}</strong><p>{t("缺少")}{missingRuntimeTools.map(([, label]) => label).join('、')}{t("。安装包内置 Node.js；Python 和 C/C++ 编译器需另装，编辑代码可继续使用。")}</p></div><button className="runtime-notice-action" onClick={() => openSettings('runtime')}>{t("配置环境")}</button><button className="icon-button" aria-label={t("关闭运行环境提醒")} onClick={dismissRuntimeNotice}><X size={14}/></button></div>}<div className="editor-tabs"><div className="tab-scroll">{files.map(file => <div key={file.path} className={`editor-tab ${active === file.path ? 'active' : ''}`} onClick={() => setActive(file.path)}><FileIcon file={file.path}/><span>{basename(file.path)}</span>{file.content !== file.saved ? <button title={t("保存修改")} className="dirty-dot" onClick={e => { e.stopPropagation(); void saveFile(file); }}>●</button> : <button title={t("关闭文件")} onClick={e => { e.stopPropagation(); closeFile(file); }}><X size={12}/></button>}</div>)}</div><button className="icon-button" title={t("新建文件")} onClick={() => { setDialog('file'); setDialogValue(''); }}><Plus size={16}/></button></div>
  <div className="editor-toolbar"><div className="breadcrumb"><FileIcon file={active}/><span>{active || t("选择或新建一个文件")}</span><ChevronRight size={13}/><span>{langLabel(lang)}</span></div><div><button className="toolbar-button save-button" title={t("保存 Ctrl+S")} disabled={!current || saving} onClick={() => saveFile()}><Save size={14}/></button><button className="toolbar-button ai-complete" disabled={!current || completionBusy} title={t("AI 补全 Ctrl+Alt+Space")} onClick={requestCompletion}>{completionBusy ? <RotateCw size={14} className="spin"/> : <WandSparkles size={14}/>}<span>{t("AI 补全")}</span></button>{isRunning ? <button className="run-button stop" onClick={stopRun}><Square size={12} fill="currentColor"/>{t("停止")}</button> : <button className="run-button" title={t("保存并运行当前文件 F5")} disabled={!current} onClick={runFile}><Play size={13} fill="currentColor"/>{state?.project.config.build[lang]?.length ? t("构建并运行") : t("运行")}<span>F5</span></button>}</div></div>
  {current ? <CodeEditor key={state?.settings.workspace} ref={editorRef} file={current} workspace={state.settings.workspace} files={files} onDefinition={focusMentorLine} onServices={setServices} onDiagnostics={(path: string, values: any[]) => setSemanticMarkers(old => ({ ...old, [path]: values }))} onChange={changeCode} onPosition={setPosition} onComplete={requestCompletion} onSave={() => { void saveFile(); }} onRun={() => { void runFile(); }} onQuickOpen={() => { setDialog('quick'); setDialogValue(''); }}/> : <div className="welcome-editor"><div className="welcome-brand"><Braces size={55}/></div><h1>{t("让想法，变成代码。")}</h1><p>{t("打开一个本地文件夹，或从小练习开始。")}</p><button className="primary-button" onClick={() => { setDialog('file'); setDialogValue('main.py'); }}><FilePlus2 size={16}/>{t("创建代码文件")}</button><button className="text-button" onClick={() => { setDialog('folder'); setDialogValue(state?.settings.workspace || ''); }}>{t("打开已有项目")}</button></div>}
  {completion && <div className="completion-preview"><div><Sparkles size={14}/><strong>{t("AI 补全建议")}</strong><span>{t("确认后插入 · 可撤销")}</span><button onClick={() => { if (!editorRef.current?.insert(completion.text, completion.context))
        notify(t("代码已变动，请重新请求补全。")); setCompletion(null); }}>{t("接受")}</button><button className="icon-button" title={t("取消补全")} onClick={() => { setCompletion(null); editorRef.current?.hideCompletion(); }}><X size={14}/></button></div><pre>{completion.text}</pre></div>}
  {terminalVisible && <section className="terminal-panel" style={{ height: terminalHeight }}><div className="resize-handle" onPointerDown={resizeTerminal}/><div className="terminal-heading"><div><button className="active"><Terminal size={13}/>{t("终端")}</button><button onClick={() => setProblemsOpen(!problemsOpen)}>{t("问题")}<span className={markers.length ? 'problem-count error' : 'problem-count'}>{problems.length}</span></button></div><div><span className="run-state">{isRunning ? <><i className="ready-dot pulse"/>{run.phase === 'compile' ? t("正在编译") : t("正在运行")}</> : run ? <><i className={run.code === 0 ? 'ready-dot' : 'missing-dot'}/>{run.stopped ? t("已停止") : tr `退出码 ${run.code}`}<span> · {(run.duration / 1000).toFixed(2)} s</span></> : t("等待运行")}</span><button className="icon-button" title={t("清空输出")} onClick={() => setOutput([])}><Trash2 size={13}/></button><button className="icon-button" title={t("关闭终端")} onClick={() => setTerminalVisible(false)}><X size={14}/></button></div></div><div className="language-status" title={Object.values(services).map((x: any) => x.name || x.error).join('\n')}>{Object.entries(services).map(([id, value]: any) => <span key={id} className={value.available ? 'ready' : 'missing'}>{value.name || id} · {value.available ? t("智能补全已就绪") : t("基础补全可用")}</span>)}</div>{problemsOpen && <div className="problems-panel" aria-label={t("代码问题")}>{problems.length ? problems.map((item, index) => <div key={index}><button onClick={() => focusMentorLine(item.path, item.line)}><AlertCircle size={12}/><span>{item.path}:{item.line} · {item.message}</span></button><button className="text-button" onClick={() => { setAiVisible(true); setAiTab('mentor'); if (mentorState.session)
        void mentorState.perform('check', { trigger: 'question', hintLevel: 'approach', question: t("请解释这个实际错误，先提示如何定位和修复：") + item.path + ':' + item.line + ' ' + item.message });
    else
        void sendMessage(t("请解释这个实际错误，先提示如何定位和修复：") + item.path + ':' + item.line + ' ' + item.message); }}>{t("请导师解释")}</button></div>) : <p>{t("当前没有代码问题。")}</p>}</div>}<div className="terminal-options"><span>{t("运行参数")}</span><input aria-label={t("运行参数")} placeholder={t("可选，例如 \"hello world\" 42")} value={args} onChange={e => setArgs(e.target.value)}/><span className="terminal-language">{langLabel(lang)}{t("· 本地进程")}</span></div><div className="terminal-output" role="log" aria-label={t("运行输出")}>{!output.length && <div className="terminal-empty"><span className="terminal-prompt">❯</span><span>{t("点击「运行」或按 F5，结果会显示在这里。")}<br /><small>{t("支持 Python、C、C++ 和 JavaScript；输入型程序可在下方发送输入。")}</small></span></div>}{output.map((line, i) => <span key={i} className={`output-${line.channel}`}>{line.text}</span>)}<div ref={terminalEnd}/></div><form className="terminal-input" onSubmit={sendInput}><ChevronRight size={14}/><input aria-label={t("程序输入")} placeholder={isRunning ? t("输入内容，按 Enter 发送给程序…") : t("运行后，可在这里输入内容")} value={input} onChange={e => setInput(e.target.value)} disabled={!isRunning || run.phase !== 'run'}/><button type="button" title={t("发送输入结束 EOF")} disabled={!isRunning || run.phase !== 'run'} onClick={() => api('input', { eof: true }).catch(e => notify(e.message))}>EOF</button><button aria-label={t("发送程序输入")} disabled={!isRunning || run.phase !== 'run'}><Send size={13}/></button></form></section>}
  <div className="editor-bottom"><span><Keyboard size={12}/>{t("普通补全")}<kbd>Ctrl Space</kbd></span><span>{t("AI 补全")}<kbd>Ctrl Alt Space</kbd></span>{!terminalVisible && <button onClick={() => setTerminalVisible(true)}><Terminal size={12}/>{t("显示终端")}</button>}</div></main>
  <aside className={`ai-panel ${aiVisible ? '' : 'hidden-panel'}`}><div className="ai-heading"><div><span className="ai-avatar"><Sparkles size={17}/></span><span><strong>{t("编程搭档")}</strong><small>{aiReady ? state.settings.model : t("连接你的 AI 服务")}</small></span></div><button className="icon-button" title={t("AI 设置")} aria-label={t("AI 设置")} onClick={() => openSettings()}><Settings size={15}/></button></div><div className="ai-tabs"><button className={aiTab === 'mentor' ? 'active' : ''} onClick={() => setAiTab('mentor')}><Sparkles size={14}/>{t("实时导师")}</button><button className={aiTab === 'chat' ? 'active' : ''} onClick={() => setAiTab('chat')}><Bot size={14}/>{t("对话")}</button><button className={aiTab === 'practice' ? 'active' : ''} onClick={() => setAiTab('practice')}><BookOpen size={14}/>{t("一步一练")}</button>{messages.length > 0 && <button className="clear-chat" title={t("清空对话")} onClick={() => { setMessages([]); retryMessages.current = []; }} disabled={aiBusy}><Trash2 size={13}/></button>}</div>{aiTab === 'mentor' ? <TaskMentor mentor={mentorState} onConfigure={() => openSettings()} onFocus={focusMentorLine}/> : aiTab === 'chat' ? <><div className="chat-messages">{messages.length === 0 && <div className="ai-welcome"><span className="welcome-spark"><Sparkles size={26}/></span><h2>{t("一起把代码写出来")}</h2><p>{t("给你一点提示，陪你解决问题。")}<br />{t("每次一个小任务，学会再往下走。")}</p><div className="ai-actions"><button onClick={() => sendMessage(t("请先解释当前代码的结构和作用，给出一个简短的改进建议。"))}><Code2 size={16}/><span>{t("解释当前代码")}<small>{t("弄懂每一步为什么这样写")}</small></span><ChevronRight size={13}/></button><button onClick={() => sendMessage(t("请结合当前代码与实际运行输出帮我排错。先指出最关键的问题，再给一条提示。"))}><CircleHelp size={16}/><span>{t("帮我找问题")}<small>{t("结合代码和终端输出分析")}</small></span><ChevronRight size={13}/></button><button onClick={() => { setAiTab('practice'); }}><BookOpen size={16}/><span>{t("开始一个小练习")}<small>{t("Python / C / C++ 项目练习")}</small></span><ChevronRight size={13}/></button></div>{!aiReady && <div className="connect-card"><div><Plug size={16}/><strong>{t("先连接你的 AI")}</strong></div><p>{t("支持 DeepSeek、自定义中转站、Responses 和 Anthropic 兼容接口。")}</p><button onClick={() => openSettings()}>{t("配置 API")}<ChevronRight size={13}/></button></div>}<div className="mentor-rule"><span>01</span>{t("先提示")}<span>02</span>{t("你来写")}<span>03</span>{t("再检查")}</div></div>}{messages.map((message, i) => <div key={i} className={`chat-message ${message.role} ${message.error ? 'message-error' : ''}`}><div className="message-label">{message.role === 'assistant' ? <Sparkles size={13}/> : <span className="tiny-avatar">{t("你")}</span>}<span>{message.role === 'assistant' ? (message.error ? t("连接提示") : t("编程搭档")) : t("你")}</span></div><Markdown content={message.content} onInsert={code => { if (editorRef.current?.insert(code))
        notify(t("代码已插入；Ctrl+Z 可撤销。"));
    else
        notify(t("请先打开代码文件。")); }} onToast={notify}/></div>)}{aiBusy && <div className="ai-thinking"><span /><span /><span /><p>{t("正在阅读代码…")}</p></div>}<div ref={chatEnd}/></div><div className="chat-compose"><div className="chat-stream-actions">{aiBusy ? <button className="secondary-button" onClick={stopChat}><Square size={12}/>{t("停止生成")}</button> : retryMessages.current.length > 0 && <button className="text-button" onClick={() => sendMessage('', true)}><RotateCw size={12}/>{t("重试上一条")}</button>}</div><button className={`context-chip ${includeContext ? 'enabled' : ''}`} onClick={() => setIncludeContext(!includeContext)} title={t("开启时会发送当前文件、选中代码与终端输出")}><FileIcon file={active}/><span>{includeContext ? basename(active) || t("当前文件") : t("不包含代码上下文")}</span>{includeContext && <Check size={12}/>}</button><div className="compose-box"><textarea aria-label={t("询问 AI")} placeholder={aiReady ? t("问点什么，或描述你想做的功能…") : t("配置 API 后，开始与你的导师对话…")} value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
        e.preventDefault();
        void sendMessage();
    } }}/><div><span>{t("Enter 发送 · Shift Enter 换行")}</span><button aria-label={t("发送 AI 消息")} disabled={!prompt.trim() || aiBusy} onClick={() => sendMessage()}>{aiBusy ? <RotateCw size={15} className="spin"/> : <Send size={15}/>}</button></div></div><p><ShieldCheck size={11}/>{aiReady ? t("实时导师会按设置自动调用 API，可暂停") : t("编辑与运行可离线使用")}</p></div></> : <div className="practice-panel"><span className="practice-eyebrow">{practice()[lang] ? langLabel(lang) : 'Python'}{t("实战练习 ·")}{lesson + 1} / {(practice()[lang] || practice().python).length}</span><div className="practice-progress">{(practice()[lang] || practice().python).map((_: any, i: number) => <span className={i <= lesson ? 'done' : ''} key={i}/>)}</div><h2>{t(selectedPractice.title)}</h2><p>{t(selectedPractice.target)}</p><div className="task-instructions"><strong>{t("你的任务")}</strong><ol><li>{t("打开练习文件，找到 TODO。")}</li><li>{t("自己尝试写出实现。")}</li><li>{t("按 F5 运行，检查输出。")}</li><li>{t("有疑问时，让 AI 给提示或检查。")}</li></ol></div><button className="primary-button" onClick={startPractice}><FilePlus2 size={14}/>{t("打开练习文件")}</button><button className="secondary-button" onClick={() => setHint(!hint)}><CircleHelp size={14}/>{hint ? t("收起提示") : t("先给我一点提示")}</button>{hint && <div className="practice-hint">{t(selectedPractice.hint)}</div>}<button className="text-button" onClick={() => sendMessage(tr `当前练习目标是：${selectedPractice.target}。请检查我的代码与运行输出。先给具体反馈和一个提示，不直接给完整答案。`)}>{t("请 AI 检查我的代码")}<ChevronRight size={14}/></button><div className="practice-navigation"><button disabled={lesson === 0} onClick={() => { setLesson(lesson - 1); setHint(false); }}>{t("上一题")}</button><button disabled={lesson >= (practice()[lang] || practice().python).length - 1} onClick={() => { setLesson(lesson + 1); setHint(false); }}>{t("下一题")}<ChevronRight size={12}/></button></div><small className="practice-note">{t("本地练习和提示不需要 API；AI 检查需要你配置服务。")}</small></div>}</aside></div>
  <footer className="statusbar"><div><span className="status-brand"><Braces size={13}/></span><span><FolderOpen size={12}/>{state ? basename(state.settings.workspace) : t("本地工作区")}</span><button onClick={() => setTerminalVisible(!terminalVisible)}><AlertCircle size={12}/>{markers.filter(x => x.severity === 'error').length}<span>△ {markers.filter(x => x.severity !== 'error').length}</span></button><span className="status-save">{saving ? t("保存中…") : current?.content !== current?.saved ? t("有未保存的修改") : t("已保存到本机")}</span></div><div><span>{tr`行 ${position.lineNumber}，列 ${position.column}`}</span><span>{t("空格: 4")}</span><span>UTF-8</span><span>{langLabel(lang)}</span><button onClick={() => openSettings()}><Sparkles size={12}/>{aiReady ? t("AI 已配置") : t("配置 AI")}</button><span className="status-local"><i />{connection ? 'Local' : 'Offline'}</span></div></footer>
  {toast && <div className="toast" role="status"><AlertCircle size={15}/>{toast}<button onClick={() => setToast('')}><X size={13}/></button></div>}
  {projectOpen && state?.project && <ProjectSettings key={state.settings.workspace} project={state.project} tools={state.tools} files={flatten(state.tree.entries).map(file => file.path)} api={api} onClose={() => setProjectOpen(false)} onSaved={projectSaved} beforeSave={() => { if (files.some(file => file.path === '.codestudio.json' && file.content !== file.saved)) {
        notify(t("请先保存配置文件中的编辑，再修改项目设置。"));
        return false;
    } return true; }}/>}
  {settingsOpen && state && <SettingsModal beforeRestore={beforeRestore} initial={state.settings} tools={state.tools} initialTab={settingsTab} onClose={() => setSettingsOpen(false)} onSaved={(data: any) => { setState((old: any) => ({ ...old, ...data })); window.dispatchEvent(new Event('studio:language-reset')); }} toast={notify}/>}
  {dialog && <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && setDialog('')}><section className={`small-modal ${dialog === 'help' ? 'help-modal' : ''}`} role="dialog" aria-modal="true" aria-label={dialog === 'folder' ? t("打开文件夹") : dialog === 'help' ? t("使用帮助") : dialog === 'quick' ? t("快速打开文件") : t("新建")}><div className="modal-title"><h2>{dialog === 'folder' ? t("打开本地文件夹") : dialog === 'directory' ? t("新建文件夹") : dialog === 'file' ? t("新建代码文件") : dialog === 'quick' ? t("快速打开文件") : t("工作台使用帮助")}</h2><button className="icon-button" aria-label={t("关闭弹窗")} onClick={() => setDialog('')}><X size={17}/></button></div>{dialog === 'help' ? <div className="help-content"><p>{t("这个工作台使用 Monaco 编辑器，提供类似 VS Code 的编辑体验。代码和运行环境都在本机。")}</p><div className="shortcut-table">{[['Ctrl + S', t("保存当前文件")], ['F5', t("保存并运行当前文件")], ['Ctrl + Space', t("普通代码补全与片段")], ['Ctrl + Alt + Space', t("请求 AI 补全")], ['Ctrl + P', t("快速打开文件")], ['Ctrl + F', t("在文件中查找")], ['Ctrl + Z', t("撤销编辑或 AI 插入")]].map(([key, desc]) => <div key={key}><kbd>{key}</kbd><span>{desc}</span></div>)}</div><p>{t("C 默认使用 C11，C++ 默认使用 C++17。在项目设置里选择多个源文件可构建项目；构建时会保存所有打开的修改。需要输入的程序可在终端底部发送输入，EOF 表示结束输入。")}</p><p>{t("在 AI 设置里填写服务商地址、模型和密钥。普通补全提供类型与成员、参数提示、跳转定义和实时错误检查；AI 补全会结合光标前后代码。按 F12 跳转定义。")}</p><p className="muted">{t("支持文本文件编辑；完整 VS Code 扩展市场、调试器和 CMake 未集成。")}</p></div> : dialog === 'quick' ? <div className="quick-open"><input autoFocus aria-label={t("快速查找文件")} placeholder={t("输入文件名…")} value={dialogValue} onChange={e => setDialogValue(e.target.value)}/><div>{state && flatten(state.tree.entries).filter(x => x.path.toLowerCase().includes(dialogValue.toLowerCase())).slice(0, 80).map(x => <button key={x.path} onClick={() => openFile(x.path)}><FileIcon file={x.path}/>{x.path}</button>)}</div></div> : <form onSubmit={submitDialog}><label>{dialog === 'folder' ? t("文件夹完整路径") : t("名称（支持已存在的子目录）")}<input autoFocus aria-label={dialog === 'folder' ? t("文件夹路径") : t("名称")} value={dialogValue} placeholder={dialog === 'folder' ? t("E:\\我的项目") : dialog === 'directory' ? 'my-project' : 'hello.py / main.c / main.cpp'} onChange={e => setDialogValue(e.target.value)}/></label>{dialog === 'folder' && <button type="button" className="secondary-button" disabled={dialogBusy} onClick={async () => { setDialogBusy(true); try {
        const data = await api('pick-folder', {});
        if (data.path)
            setDialogValue(data.path);
    }
    catch (e: any) {
        notify(e.message);
    }
    finally {
        setDialogBusy(false);
    } }}><FolderOpen size={14}/>{t("浏览文件夹…")}</button>}<p className="muted">{dialog === 'folder' ? t("选择已有项目；文件会直接保存到这个文件夹。") : tr `保存位置：${state?.settings.workspace}`}</p><div className="modal-footer"><button type="button" className="secondary-button" onClick={() => setDialog('')}>{t("取消")}</button><button className="primary-button" disabled={dialogBusy || !dialogValue.trim()}>{dialogBusy ? t("处理中…") : dialog === 'folder' ? t("打开文件夹") : t("创建")}</button></div></form>}</section></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
