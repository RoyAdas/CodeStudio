import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
export function createLearning({ dataDir, getWorkspace }) {
  const file = path.join(dataDir, 'learning.json'); let queue = Promise.resolve();
  const key = root => crypto.createHash('sha256').update(root.toLowerCase()).digest('hex');
  async function load() { try { const value = JSON.parse(await fs.readFile(file, 'utf8')); if (value.version !== 1 || !value.workspaces || typeof value.workspaces !== 'object') throw Error('Invalid learning data'); return value; } catch (error) { if (error.code === 'ENOENT') return { version: 1, workspaces: {} }; throw Error('学习记录无法读取，请先检查或备份 learning.json。'); } }
  const locked = fn => { const next = queue.catch(() => {}).then(fn); queue = next; return next; };
  async function persist(value) { const temp = file + '.tmp'; await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await fs.rename(temp, file); }
  function observe(root, session) {
    if (!session) return;
    return locked(async () => {
      const value = await load(); const workspace = value.workspaces[key(root)] ||= { tasks: {} }; const old = workspace.tasks[session.id] || {};
      const mistakes = old.mistakes || [];
      if (session.review?.status === 'needs_fix' && !mistakes.some(item => item.time === session.review.time)) mistakes.push({ time: session.review.time, step: session.currentStep, note: session.review.note, hint: session.review.hint });
      workspace.tasks[session.id] = { ...old, id: session.id, title: session.title, task: session.task, status: session.status, completedSteps: session.steps.filter(item => item.completed).length, totalSteps: session.steps.length, updatedAt: session.updatedAt || Date.now(), createdAt: session.createdAt || old.createdAt || Date.now(), mistakes: mistakes.slice(-50), minutes: old.minutes || 0 };
      const tasks = Object.values(workspace.tasks).sort((a, b) => b.updatedAt - a.updatedAt); workspace.tasks = Object.fromEntries(tasks.slice(0, 200).map(item => [item.id, item])); await persist(value);
    });
  }
  async function state() { await queue.catch(() => {}); const value = await load(); const tasks = Object.values(value.workspaces[key(getWorkspace())]?.tasks || {}).sort((a, b) => b.updatedAt - a.updatedAt); return { tasks, completed: tasks.filter(task => task.status === 'completed').length, completedSteps: tasks.reduce((n, item) => n + item.completedSteps, 0), minutes: tasks.reduce((n, item) => n + item.minutes, 0) }; }
  async function save(input) {
    return locked(async () => { const value = await load(); const task = value.workspaces[key(getWorkspace())]?.tasks?.[input.id]; if (!task) throw Error('学习任务记录不存在。');
      if (input.text !== undefined) { if (typeof input.text !== 'string' || input.text.length > 20000) throw Error('复盘内容过大。'); task.recap = input.text; task.recapSavedAt = Date.now(); }
      if (input.minutes !== undefined) task.minutes = (task.minutes || 0) + Math.max(0, Math.min(2, Number(input.minutes) || 0));
      await persist(value); return { ok: true };
    });
  }
  return { observe, state, save, flush: () => queue };
}
