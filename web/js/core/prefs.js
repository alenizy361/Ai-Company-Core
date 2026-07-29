// Persisted preferences under sira.* keys, with a one-shot migration from
// the previous product's keys so an existing owner keeps their conversation
// and language across the rebrand.
const LEGACY = { lang: 'rabit.lang', conversationId: 'rabit.conversationId' };

function migrateOnce() {
  try {
    if (localStorage.getItem('sira.migrated')) return;
    for (const [key, oldKey] of Object.entries(LEGACY)) {
      const old = localStorage.getItem(oldKey);
      if (old !== null && localStorage.getItem(`sira.${key}`) === null) {
        localStorage.setItem(`sira.${key}`, old);
      }
      localStorage.removeItem(oldKey);
    }
    localStorage.setItem('sira.migrated', '1');
  } catch { /* storage unavailable (private mode) — run stateless */ }
}
migrateOnce();

export const prefs = {
  get(key) {
    try { return localStorage.getItem(`sira.${key}`); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(`sira.${key}`, value); } catch { /* stateless */ }
  },
  remove(key) {
    try { localStorage.removeItem(`sira.${key}`); } catch { /* stateless */ }
  },
  bool(key) {
    return prefs.get(key) === '1';
  },
  setBool(key, on) {
    prefs.set(key, on ? '1' : '0');
  },
};

/** Reduced motion = OS preference OR the user's explicit in-app toggle. */
export function motionAllowed() {
  if (prefs.get('motion') === 'reduced') return false;
  if (prefs.get('motion') === 'full') return true;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function applyMotionAttr() {
  document.documentElement.dataset.reducedMotion = motionAllowed() ? 'false' : 'true';
}
