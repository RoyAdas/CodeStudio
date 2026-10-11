type Services = Record<string, { available: boolean; name?: string; error?: string }>;
const modelPath = (model: any) => decodeURIComponent(model.uri.path.replace(/^\//, ''));
const uri = (m: any, path: string) => m.Uri.parse(`inmemory://workspace/${encodeURIComponent(path)}`);
const range = (r: any) => ({ startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 });
const markdown = (value: any): any[] => !value ? [] : Array.isArray(value) ? value.flatMap(markdown) : typeof value === 'string' ? [{ value }] : [{ value: value.language ? '```' + value.language + '\n' + value.value + '\n```' : value.value || '', isTrusted: false }];

export function attachLanguageServices(m: any, editor: any, api: any, callbacks: any) {
  const disposables: any[] = []; let disposed = false; let timer: any; let pending: Promise<any> = Promise.resolve(); let services: Services = {}; let synced = '';
  const requests = new Set<AbortController>();
  const snapshot = () => m.editor.getModels().filter((model: any) => callbacks.files().some((file: any) => file.path === modelPath(model)) && ['python', 'c', 'cpp'].includes(model.getLanguageId())).map((model: any) => ({ path: modelPath(model), content: model.getValue(), version: model.getVersionId() }));
  async function sync() {
    if (disposed) return;
    const files = snapshot(); const signature = JSON.stringify(files.map((x: any) => [x.path, x.version]));
    if (signature === synced) return pending;
    synced = signature;
    pending = pending.catch(() => {}).then(async () => {
      if (disposed) return;
      try { const value = await api('language/sync', { files, workspace: callbacks.workspace() }); services = value.services; callbacks.status(services); }
      catch (error: any) { synced = ''; callbacks.status({ unavailable: { available: false, error: error.message } }); }
    });
    return pending;
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(() => void sync(), 350); }
  async function query(model: any, position: any, method: string, cancellation: any) {
    await sync(); if (disposed || !services[model.getLanguageId() === 'python' ? 'python' : 'cpp']?.available) return null;
    const version = model.getVersionId(); const controller = new AbortController(); requests.add(controller);
    const unsubscribe = cancellation?.onCancellationRequested(() => controller.abort());
    if (cancellation?.isCancellationRequested) controller.abort();
    try {
      const value = await api('language/query', { path: modelPath(model), version, method, position: { line: position.lineNumber - 1, character: position.column - 1 } }, controller.signal);
      return disposed || model.isDisposed() || model.getVersionId() !== version || value.stale ? null : value.result;
    } catch { return null; } finally { requests.delete(controller); unsubscribe?.dispose(); }
  }
  for (const language of ['python', 'c', 'cpp']) {
    disposables.push(m.languages.registerCompletionItemProvider(language, { triggerCharacters: ['.', ':', '>'], async provideCompletionItems(model: any, position: any, _context: any, cancellation: any) {
      const result = await query(model, position, 'textDocument/completion', cancellation); const word = model.getWordUntilPosition(position);
      const fallback = new m.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const kinds: any = { 1: 'Text', 2: 'Method', 3: 'Function', 4: 'Constructor', 5: 'Field', 6: 'Variable', 7: 'Class', 8: 'Interface', 9: 'Module', 10: 'Property', 11: 'Unit', 12: 'Value', 13: 'Enum', 14: 'Keyword', 15: 'Snippet', 16: 'Color', 17: 'File', 18: 'Reference', 19: 'Folder', 20: 'EnumMember', 21: 'Constant', 22: 'Struct', 23: 'Event', 24: 'Operator', 25: 'TypeParameter' };
      return { suggestions: (Array.isArray(result) ? result : result?.items || []).slice(0, 300).map((item: any) => ({ label: item.label, detail: item.detail || services[language === 'python' ? 'python' : 'cpp']?.name, documentation: markdown(item.documentation)[0], kind: m.languages.CompletionItemKind[kinds[item.kind] || 'Text'], insertText: item.textEdit?.newText || item.insertText || item.label, insertTextRules: item.insertTextFormat === 2 ? m.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined, range: item.textEdit?.range ? range(item.textEdit.range) : item.textEdit?.replace ? range(item.textEdit.replace) : fallback, sortText: `00${item.sortText || item.label}`, filterText: item.filterText, additionalTextEdits: item.additionalTextEdits?.map((edit: any) => ({ range: range(edit.range), text: edit.newText })) })) };
    } }));
    disposables.push(m.languages.registerHoverProvider(language, { async provideHover(model: any, position: any, cancellation: any) { const value = await query(model, position, 'textDocument/hover', cancellation); return value ? { contents: markdown(value.contents), range: value.range ? range(value.range) : undefined } : null; } }));
    disposables.push(m.languages.registerSignatureHelpProvider(language, { signatureHelpTriggerCharacters: ['(', ','], signatureHelpRetriggerCharacters: [')'], async provideSignatureHelp(model: any, position: any, cancellation: any) { const value = await query(model, position, 'textDocument/signatureHelp', cancellation); return value ? { value: { ...value, signatures: value.signatures.map((item: any) => ({ ...item, documentation: markdown(item.documentation)[0], parameters: (item.parameters || []).map((p: any) => ({ ...p, documentation: markdown(p.documentation)[0] })) })) }, dispose() {} } : null; } }));
    disposables.push(m.languages.registerDefinitionProvider(language, { async provideDefinition(model: any, position: any, cancellation: any) { const value = await query(model, position, 'textDocument/definition', cancellation); return (value || []).map((x: any) => ({ uri: uri(m, x.path), range: range(x.range) })); } }));
  }
  disposables.push(m.editor.registerEditorOpener({ openCodeEditor(_source: any, resource: any, selection: any) { if (resource.scheme !== 'inmemory' || resource.authority !== 'workspace') return false; callbacks.definition(decodeURIComponent(resource.path.replace(/^\//, '')), selection?.startLineNumber || selection?.lineNumber || 1); return true; } }));
  const diagnostics = (event: any) => {
    const value = event.detail; if (value.workspace !== callbacks.workspace()) return;
    const model = m.editor.getModel(uri(m, value.path)); if (!model || model.getVersionId() !== value.version) return;
    m.editor.setModelMarkers(model, 'language-service', value.markers.map((x: any) => ({ startLineNumber: x.line, startColumn: x.column, endLineNumber: x.endLine, endColumn: x.endColumn, message: x.message, source: x.source, severity: x.severity === 'error' ? m.MarkerSeverity.Error : m.MarkerSeverity.Warning })));
    callbacks.diagnostics(value.path, value.markers);
  };
  window.addEventListener('studio:language-diagnostics', diagnostics);
  const reset = () => { synced = ''; services = {}; schedule(); };
  window.addEventListener('studio:language-reset', reset);
  disposables.push(editor.onDidChangeModelContent(schedule), editor.onDidChangeModel(schedule)); schedule();
  return { sync: schedule, dispose() { disposed = true; clearTimeout(timer); for (const request of requests) request.abort(); disposables.forEach(x => x.dispose()); window.removeEventListener('studio:language-diagnostics', diagnostics); window.removeEventListener('studio:language-reset', reset); } };
}
