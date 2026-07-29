// Global command palette (Ctrl/Cmd+K): Ask SIRA / Find (real /api/search) /
// Navigate. Arabic input works regardless of interface language; every
// result row keeps its natural direction.
import { el, mount, prose } from '../core/dom.js';
import { t, locale } from '../i18n/i18n.js';
import { openLayer, closeLayer } from '../a11y/focus.js';

const MODES = ['ask', 'find', 'navigate'];

export function buildPalette({ onAsk, onNavigate, onOpenResult }) {
  const palette = document.getElementById('palette');
  const ov = document.getElementById('paletteOv');
  let mode = 'ask';
  let debounceTimer = null;

  function close() {
    palette.classList.remove('open');
    ov.classList.remove('open');
    closeLayer(palette);
  }
  ov.addEventListener('click', close);

  function navTargets() {
    return [
      { id: 'chat', label: t('palette.nav.chat') },
      { id: 'activity', label: t('palette.nav.activity') },
      { id: 'language', label: t('palette.nav.language') },
      { id: 'motion', label: t('palette.nav.motion') },
    ];
  }

  function build() {
    mount(palette,
      el('input', { id: 'paletteInp', placeholder: t('palette.placeholder'), dir: 'auto', 'aria-label': t('palette.placeholder') }),
      el('div', { id: 'paletteModes', role: 'tablist' }, MODES.map((m) =>
        el('button', {
          class: 'mode', role: 'tab', 'aria-selected': String(m === mode), dataset: { mode: m },
          onclick: () => setMode(m),
        }, t(`palette.${m}`)))),
      el('div', { id: 'paletteResults' }),
    );
    const inp = palette.querySelector('#paletteInp');
    inp.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void update(), 200);
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = inp.value.trim();
        if (mode === 'ask' && q) {
          close();
          onAsk(q);
        } else {
          palette.querySelector('.presult')?.click();
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        palette.querySelector('.presult')?.focus();
      }
    });
    void update();
  }

  function setMode(m) {
    mode = m;
    for (const btn of palette.querySelectorAll('.mode')) {
      btn.setAttribute('aria-selected', String(btn.dataset.mode === m));
    }
    void update();
  }

  async function update() {
    const results = palette.querySelector('#paletteResults');
    const q = palette.querySelector('#paletteInp')?.value.trim() ?? '';
    if (!results) return;

    if (mode === 'navigate' || (mode === 'ask' && !q)) {
      mount(results, navTargets()
        .filter((target) => !q || target.label.toLowerCase().includes(q.toLowerCase()))
        .map((target) => el('button', {
          class: 'presult',
          onclick: () => { close(); onNavigate(target.id); },
        }, el('span', { class: 'ptype' }, t('palette.navigate')), target.label)));
      return;
    }
    if (mode === 'ask') {
      mount(results, el('div', { class: 'empty' }, t('palette.hint.ask')));
      return;
    }
    // Find mode: real backend search.
    if (q.length < 2) {
      mount(results, el('div', { class: 'empty' }, t('palette.noResults')));
      return;
    }
    try {
      const data = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
      const rows = (data.results ?? []).map((r) => el('button', {
        class: 'presult',
        onclick: () => { close(); onOpenResult(r); },
      },
        el('span', { class: 'ptype' }, t(`palette.type.${r.type}`)),
        prose(r.title),
        r.snippet ? el('small', null, ' ', prose(r.snippet)) : null,
      ));
      mount(results, rows.length ? rows : el('div', { class: 'empty' }, t('palette.noResults')));
    } catch {
      mount(results, el('div', { class: 'empty' }, t('palette.noResults')));
    }
  }

  locale.subscribe(() => {
    if (palette.classList.contains('open')) build();
  });

  return {
    open(initialMode = 'ask') {
      mode = initialMode;
      build();
      palette.classList.add('open');
      ov.classList.add('open');
      openLayer(palette, close);
      palette.querySelector('#paletteInp')?.focus();
    },
    close,
    get isOpen() {
      return palette.classList.contains('open');
    },
  };
}
