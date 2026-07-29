// Shell chrome: header, bottom controls, banner, drawer plumbing, and the
// render registry that makes the language toggle complete by construction —
// every region re-renders through it on locale change.
import { el, mount } from '../core/dom.js';
import { t, locale } from '../i18n/i18n.js';
import { openLayer, closeLayer } from '../a11y/focus.js';

const regions = new Set();

/** Register a re-renderable region; runs immediately and on locale change. */
export function registerRegion(renderFn) {
  regions.add(renderFn);
  renderFn();
  return () => regions.delete(renderFn);
}

locale.subscribe(() => {
  for (const fn of regions) fn();
});

/* ---------- drawers ---------- */
const openDrawers = new Map(); // drawerEl -> ovEl

export function openDrawer(ov, drawer) {
  ov.classList.add('open');
  drawer.classList.add('open');
  openDrawers.set(drawer, ov);
  openLayer(drawer, () => closeDrawer(ov, drawer));
}

export function closeDrawer(ov, drawer) {
  ov.classList.remove('open');
  drawer.classList.remove('open');
  openDrawers.delete(drawer);
  closeLayer(drawer);
}

export function toggleDrawer(ov, drawer, prepare) {
  if (drawer.classList.contains('open')) closeDrawer(ov, drawer);
  else {
    prepare?.();
    openDrawer(ov, drawer);
  }
}

/* ---------- header ---------- */
export function buildHeader({ onLang }) {
  const header = document.getElementById('header');
  const render = () => {
    mount(header,
      el('h1', null, t('app.title')),
      el('span', { class: 'badge', id: 'connBadge' }, '…'),
      el('span', { class: 'badge', id: 'workerBadge' }, ''),
      el('span', { class: 'badge warn', id: 'adapterBadge', hidden: true }, t('badge.mock')),
      el('div', { class: 'spacer' }),
      el('span', { class: 'badge', id: 'micBadge' }, t('badge.micOff')),
      el('button', {
        class: 'sbtn small', id: 'langBtn', 'aria-label': t('controls.language'),
        onclick: onLang,
      }, t('lang.switchTo')),
    );
  };
  registerRegion(render);
}

/** Update the truth badges from live signals (called on every store notify). */
export function renderHeaderState({ connected, backendReachable, workerFresh, adapter, micState }) {
  const conn = document.getElementById('connBadge');
  if (conn) {
    conn.textContent = !backendReachable ? t('badge.backendUnreachable') : connected ? t('badge.live') : t('badge.disconnected');
    conn.className = `badge ${!backendReachable || !connected ? 'off' : 'live'}`;
  }
  const worker = document.getElementById('workerBadge');
  if (worker) {
    worker.textContent = workerFresh ? t('badge.workerOnline') : t('badge.workerOffline');
    worker.className = `badge ${workerFresh ? 'live' : 'off'}`;
  }
  const banner = document.getElementById('banner');
  const adapterBadge = document.getElementById('adapterBadge');
  if (adapterBadge && banner) {
    if (adapter?.name === 'mock') {
      adapterBadge.hidden = false;
      banner.classList.add('visible');
      banner.textContent = t('banner.mock', { reason: adapter.reason ?? '' });
    } else {
      adapterBadge.hidden = true;
      banner.classList.remove('visible');
    }
  }
  const mic = document.getElementById('micBadge');
  if (mic && micState) {
    mic.textContent = micState === 'muted' ? t('badge.micMuted') : micState === 'live' ? t('badge.micLive') : t('badge.micOff');
    mic.className = `badge ${micState === 'muted' ? 'off' : micState === 'live' ? 'warn' : ''}`;
  }
}

/* ---------- bottom controls ---------- */
export function buildControls({ onMute, onChat, onTalk, onSearch, onActivity, onStop }) {
  const nav = document.getElementById('controls');
  const render = () => {
    mount(nav,
      el('button', { class: 'cbtn', id: 'muteBtn', 'aria-label': t('controls.mute'), onclick: onMute }, '🔇'),
      el('button', { class: 'cbtn', id: 'chatBtn', 'aria-label': t('controls.chat'), onclick: onChat }, '💬'),
      el('button', { class: 'cbtn', id: 'talkBtn', 'aria-label': t('controls.talk') }, '🎙️'),
      el('button', { class: 'cbtn', id: 'stopBtn', 'aria-label': t('controls.stop'), onclick: onStop, hidden: true }, '⏹'),
      el('button', { class: 'cbtn', id: 'searchBtn', 'aria-label': t('controls.search'), onclick: onSearch }, '🔍'),
      el('button', { class: 'cbtn', id: 'activityBtn', 'aria-label': t('controls.activity'), onclick: onActivity },
        '📋', el('span', { class: 'cnt', id: 'apprCnt', hidden: true }, '0')),
    );
    // Talk: tap = toggle turn / barge-in; hold (>=300ms) = hold-to-talk.
    const talk = document.getElementById('talkBtn');
    let holdTimer = null;
    let holding = false;
    talk.addEventListener('pointerdown', () => {
      holdTimer = setTimeout(() => {
        holding = true;
        onTalk({ hold: true, phase: 'start' });
      }, 300);
    });
    const release = () => {
      clearTimeout(holdTimer);
      if (holding) {
        holding = false;
        onTalk({ hold: true, phase: 'end' });
      }
    };
    talk.addEventListener('pointerup', (e) => {
      clearTimeout(holdTimer);
      if (holding) release();
      else onTalk({ hold: false });
      e.preventDefault();
    });
    talk.addEventListener('pointercancel', release);
    talk.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onTalk({ hold: false });
      }
    });
  };
  registerRegion(render);
}

export function setApprovalCount(n) {
  const cnt = document.getElementById('apprCnt');
  if (!cnt) return;
  cnt.hidden = n === 0;
  cnt.textContent = String(n);
}

export function setStopVisible(visible) {
  const stop = document.getElementById('stopBtn');
  if (stop) stop.hidden = !visible;
}

export function setMuted(muted) {
  const talk = document.getElementById('talkBtn');
  const mute = document.getElementById('muteBtn');
  talk?.classList.toggle('muted', muted);
  if (mute) {
    mute.textContent = muted ? '🔈' : '🔇';
    mute.setAttribute('aria-label', muted ? t('controls.unmute') : t('controls.mute'));
  }
}
