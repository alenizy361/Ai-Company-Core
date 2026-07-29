// Locale store + translation. English/LTR is the default; the selection
// persists across sessions. Switching re-renders every registered region
// (see shell.js renderRegistry) so the toggle is complete by construction.
import en from './en.js';
import ar from './ar.js';
import { prefs } from '../core/prefs.js';

const DICTS = { en, ar };
export const DEFAULT_LOCALE = 'en';

let current = prefs.get('lang') || DEFAULT_LOCALE;
if (!DICTS[current]) current = DEFAULT_LOCALE;
const listeners = new Set();

export function dirFor(locale) {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

function applyToDocument() {
  document.documentElement.lang = current;
  document.documentElement.dir = dirFor(current);
}

export const locale = {
  get: () => current,
  dir: () => dirFor(current),
  set(next) {
    if (!DICTS[next] || next === current) return;
    current = next;
    prefs.set('lang', next);
    applyToDocument();
    for (const fn of listeners) fn(next);
  },
  toggle() {
    locale.set(current === 'ar' ? 'en' : 'ar');
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/** t('card.objective.progress', {done: 2, total: 5}) with en fallback. */
export function t(key, params) {
  let str = DICTS[current][key] ?? DICTS.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  }
  return str;
}

export function fmtNumber(n) {
  return new Intl.NumberFormat(current === 'ar' ? 'ar' : 'en').format(n);
}

export function fmtTime(epochMs) {
  return new Intl.DateTimeFormat(current === 'ar' ? 'ar' : 'en', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(epochMs));
}

export function execCountLabel(n) {
  return n === 1 ? t('exec.count.one') : t('exec.count', { n: fmtNumber(n) });
}

applyToDocument();
