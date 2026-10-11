// Shared snapshot normalization keeps checks tied to the code that was reviewed.
export function textFingerprint(text) {
  const value = String(text || ''); let a = 2166136261; let b = 5381;
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ value.charCodeAt(i); }
  return `${value.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}
export function isSensitiveMentorPath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').toLowerCase();
  const parts = normalized.split('/'); const name = parts.at(-1) || '';
  return parts.some(part => ['.git', '.ssh', 'data', '.aws'].includes(part))
    || /^\.env(?:\.|$)/.test(name)
    || /\.(?:pem|key|p12|pfx|keystore)$/.test(name)
    || /^(?:credentials?|secrets?)(?:\.|$)/.test(name)
    || /^(?:id_rsa|id_ed25519|id_ecdsa)(?:\.|$)/.test(name);
}
export function normalizeMentorContext(input = {}) {
  const clean = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  const activePath = clean(input.activePath || input.path, 400);
  const sources = Array.isArray(input.files) ? input.files : activePath ? [{ path: activePath, code: input.code || '' }] : [];
  const unique = new Map(); let budget = 36000;
  for (const file of [...sources].sort((a, b) => Number(b.path === activePath) - Number(a.path === activePath))) {
    if (unique.size >= 6 || budget <= 0) break;
    const filePath = clean(file?.path, 400); if (!filePath || unique.has(filePath) || isSensitiveMentorPath(filePath)) continue;
    const original = typeof (file.code ?? file.content) === 'string' ? file.code ?? file.content : '';
    const code = clean(original, Math.min(18000, budget)); budget -= code.length;
    const sourceFingerprint = clean(file.sourceFingerprint, 100) || textFingerprint(original);
    unique.set(filePath, { path: filePath, code, sourceFingerprint, truncated: !!file.truncated || original.length > code.length });
  }
  const files = [...unique.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const run = input.run && typeof input.run === 'object' && !isSensitiveMentorPath(input.run.path) ? {
    id: clean(input.run.id, 100), path: clean(input.run.path, 400), phase: clean(input.run.phase, 30),
    code: typeof input.run.code === 'number' ? input.run.code : null, stopped: !!input.run.stopped,
    sourceFingerprint: clean(input.run.sourceFingerprint, 100), output: clean(String(input.run.output || '').slice(-10000), 10000),
  } : null;
  if (run) run.matchesCurrentCode = !!run.sourceFingerprint && files.some(file => file.path === run.path && file.sourceFingerprint === run.sourceFingerprint);
  const result = { activePath: isSensitiveMentorPath(activePath) ? '' : activePath, language: clean(input.language, 30), files, selection: isSensitiveMentorPath(activePath) ? '' : clean(input.selection, 2000), run };
  if (input.tests?.id) {
    const tests = input.tests;
    const fingerprints = (Array.isArray(tests.sources) ? tests.sources : []).slice(0, 1000).filter(item => !isSensitiveMentorPath(item.path)).map(item => ({ path: clean(item.path, 400), sourceFingerprint: clean(item.sourceFingerprint, 100) }));
    result.tests = { id: clean(tests.id, 100), phase: clean(tests.phase, 30), passed: !!tests.passed, stopped: !!tests.stopped, exitCode: typeof tests.exitCode === 'number' ? tests.exitCode : null, sources: fingerprints, cases: (Array.isArray(tests.cases) ? tests.cases : []).slice(0, 100).map(item => ({ id: clean(item.id, 300), status: clean(item.status, 30), detail: clean(item.detail, 2000) })), output: clean(String(tests.output || '').slice(-5000), 5000), matchesCurrentCode: tests.matchesCurrentCode !== false && tests.matchesDisk !== false && tests.phase === 'finished' && files.every(file => fingerprints.some(item => item.path === file.path && item.sourceFingerprint === file.sourceFingerprint)), error: clean(tests.error, 1000) };
  }
  if (input.debug?.phase === 'paused') {
    const debug = input.debug;
    result.debug = { id: clean(debug.id, 100), phase: 'paused', sources: (debug.sources || []).slice(0, 6), frames: (debug.frames || []).filter(frame => !isSensitiveMentorPath(frame.path)).slice(0, 10), variables: (debug.variables || []).slice(0, 50).map(item => ({ name: clean(item.name, 150), value: clean(item.value, 1000), type: clean(item.type, 100) })), matchesCurrentCode: files.every(file => (debug.sources || []).some(item => item.path === file.path && item.sourceFingerprint === file.sourceFingerprint)) };
  }
  return result;
}
export function contextFingerprint(input) {
  const { activePath, files, run, tests, debug } = normalizeMentorContext(input);
  return textFingerprint(JSON.stringify({ activePath, files, run, ...(tests ? { tests } : {}), ...(debug ? { debug } : {}) }));
}
