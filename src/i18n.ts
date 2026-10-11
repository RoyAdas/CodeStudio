import { useSyncExternalStore } from 'react';
import english from './locales/en.json';
let locale = (() => { try { return localStorage.getItem('studio-locale') === 'en' ? 'en' : 'zh-CN'; } catch { return 'zh-CN'; } })();
const listeners = new Set<() => void>();
export function setLocale(value: string) { locale = value === 'en' ? 'en' : 'zh-CN'; document.documentElement.lang = locale; try { localStorage.setItem('studio-locale', locale); } catch {} for (const listener of listeners) listener(); }
export const getLocale = () => locale;
export function useLocale() { return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, getLocale); }
export function t(value: string): string {
  if (locale !== 'en' || !value) return value;
  const direct = (english as Record<string, string>)[value]; if (direct) return direct;
  return value;
}
export function tr(parts: TemplateStringsArray, ...values: any[]) { const key = parts.reduce((text, part, index) => text + (index ? `{${index - 1}}` : '') + part, ''); return t(key).replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)])); }
