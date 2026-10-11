import fs from 'node:fs/promises';
import path from 'node:path';

export const PROJECT_FILE = '.codestudio.json';
export const projectDefaults = () => ({ version: 1, python: { mode: 'auto', venv: '.venv' }, build: { c: [], cpp: [], includeDirs: [], cStandard: 'c11', cppStandard: 'c++17' } });
const bad = message => { const error = Error(message); error.status = 400; throw error; };

function relative(value, name, allowRoot = false) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) bad(`${name}需要工作区内的相对路径。`);
  const normalized = value.trim().replace(/\\/g, '/');
  if (normalized.includes('\0') || normalized.includes(':') || normalized.startsWith('/') || normalized.split('/').includes('..')) bad(`${name}不能指向工作区外。`);
  if (!allowRoot && (normalized === '.' || normalized === './')) bad(`${name}不能是工作区根目录。`);
  return path.posix.normalize(normalized);
}

export function normalizeProject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('项目配置必须是 JSON 对象。');
  if (input.version !== undefined && input.version !== 1) bad('项目配置版本不支持。');
  const defaults = projectDefaults();
  const python = input.python ?? {}; const build = input.build ?? {};
  if (!python || typeof python !== 'object' || Array.isArray(python) || !build || typeof build !== 'object' || Array.isArray(build)) bad('项目配置的 python 和 build 必须是对象。');
  const mode = python.mode ?? defaults.python.mode;
  if (!['auto', 'system', 'venv'].includes(mode)) bad('Python 模式必须是 auto、system 或 venv。');
  const venv = relative(python.venv ?? defaults.python.venv, '虚拟环境');
  // Environment creation is intentionally restricted to a direct child folder.
  if (venv.includes('/') || !/^\.?[\p{L}\p{N}_-]+$/u.test(venv)) bad('虚拟环境名称只能包含字母、数字、中文、下划线或连字符，可用 .venv。');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(venv)) bad('虚拟环境名称不能使用 Windows 保留设备名。');
  const list = (value, name, extensions) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 64) bad(`${name}最多支持 64 项。`);
    return [...new Set(value.map(item => {
      const result = relative(item, name, !extensions);
      if (extensions && !extensions.includes(path.posix.extname(result).toLowerCase())) bad(`${name}包含不支持的源文件类型：${result}`);
      return result;
    }))];
  };
  const cStandard = build.cStandard ?? defaults.build.cStandard;
  const cppStandard = build.cppStandard ?? defaults.build.cppStandard;
  if (!['c99', 'c11', 'c17', 'c23'].includes(cStandard)) bad('不支持这个 C 标准。');
  if (!['c++11', 'c++14', 'c++17', 'c++20', 'c++23'].includes(cppStandard)) bad('不支持这个 C++ 标准。');
  return { version: 1, python: { mode, venv }, build: {
    c: list(build.c, 'C 源文件', ['.c']), cpp: list(build.cpp, 'C++ 源文件', ['.c', '.cpp', '.cc', '.cxx']),
    includeDirs: list(build.includeDirs, '头文件目录'), cStandard, cppStandard,
  } };
}

export async function readProject(root, safePath) {
  try {
    const file = await safePath(PROJECT_FILE);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 65536) bad('项目配置不是文件，或超过 64 KB。');
    const raw = await fs.readFile(file, 'utf8');
    return { config: normalizeProject(JSON.parse(raw.replace(/^\uFEFF/, ''))), exists: true, error: '' };
  } catch (error) {
    if (error.code === 'ENOENT') return { config: projectDefaults(), exists: false, error: '' };
    return { config: projectDefaults(), exists: true, error: `无法读取 ${PROJECT_FILE}：${error instanceof SyntaxError ? 'JSON 格式不正确。' : error.message}` };
  }
}
