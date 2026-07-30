// SIRA client entry: wires backend truth, the voice pipeline, the neural
// network, cards, chat, search, and accessibility together. Every visible
// datum derives from the backend snapshot + persisted SSE events or a real
// device signal. Nothing is animated or labeled without a source.
import { BackendStore } from './core/store.js';
import { ConversationStore } from './core/conversation.js';
import { deriveCoreState } from './core/core-state.js';
import { prefs, applyMotionAttr } from './core/prefs.js';
import { el, mount, prose } from './core/dom.js';
import { t, locale, execCountLabel } from './i18n/i18n.js';
import { langOf } from './i18n/bidi.js';
import { announcer } from './a11y/announcer.js';
import { bindKey, isPaletteKey } from './a11y/keys.js';
import {
  registerRegion, buildHeader, buildControls, renderHeaderState,
  openDrawer, closeDrawer, toggleDrawer, setApprovalCount, setStopVisible, setMuted,
} from './ui/shell.js';
import { buildChat } from './ui/chat.js';
import { buildActivity } from './ui/activity.js';
import { buildCards } from './ui/cards.js';
import { buildPalette } from './ui/palette.js';
import { buildInspector } from './ui/inspector.js';
import { NetworkGraph } from './network/graph.js';
import { SiraCore } from './sira/core.js';
import { VoiceController } from './voice/controller.js';

const $ = (id) => document.getElementById(id);
applyMotionAttr();

const backend = new BackendStore();
const conversation = new ConversationStore();

/* ---------- language-switch offer (never auto-switch) ---------- */
const langOffer = {
  recent: [], // langs of last final user messages
  declined: false,
  seq: 1,
  note(text) {
    this.recent.push(langOf(text));
    if (this.recent.length > 3) this.recent.shift();
    this.seq += 1;
  },
  current() {
    if (this.declined || this.recent.length < 3) return null;
    const target = this.recent.every((l) => l === 'ar') ? 'ar' : this.recent.every((l) => l === 'en') ? 'en' : null;
    if (!target || target === locale.get()) return null;
    return { to: target, count: this.recent.length, seq: this.seq };
  },
  decline() {
    this.declined = true;
    void cards.render();
  },
};

/* ---------- voice controller ---------- */
let assistantUpdate = null; // active streaming-bubble updater
let voiceRef = null;
let currentCoreState = 'initializing';

const voice = new VoiceController({
  onStateChange() {
    updateCoreState();
    const micLive = voiceRef?.capture.active ?? false;
    const state = voiceRef?.state ?? 'initializing';
    $('micDot').classList.toggle('on', ['listening', 'detecting_end_of_turn', 'transcribing'].includes(state));
    renderHeaderState({
      connected: backend.connected,
      backendReachable: backend.snapshot !== null,
      workerFresh: backend.workerFresh(),
      adapter: backend.health?.adapter,
      micState: state === 'muted' ? 'muted' : micLive ? 'live' : 'off',
    });
    if (state === 'listening') announcer.say(t('announce.listening'));
  },
  onTranscript(text, isFinal) {
    mount($('transcriptLine'), prose(text));
    if (isFinal) {
      conversation.addUser(text);
      langOffer.note(text);
      assistantUpdate = conversation.beginAssistant();
      void cards.render();
    }
  },
  onDelta(fullText) {
    // Streaming fast path: single text-node update, direction-stable.
    setReplyText(fullText, { streaming: true });
    assistantUpdate?.(fullText);
  },
  onReply(text, { interrupted, done } = {}) {
    if (interrupted) {
      conversation.addSystem(text, t('chat.unspoken'));
      return;
    }
    setReplyText(text, { streaming: false });
    if (done) {
      assistantUpdate?.(text, { done: true });
      assistantUpdate = null;
      announcer.say(t('announce.responseStarted'));
    }
  },
  onRoute(data) {
    if (data.route === 'create_objective' && data.objectiveId) {
      conversation.addSystem(t('chat.objectiveCreated'));
    }
  },
  onError({ key, params, preserveText }) {
    conversation.addSystem(`⚠ ${t(key, params)}`);
    if (preserveText) chat.setUnsentText(preserveText);
  },
  onGenerating(active) {
    setStopVisible(active);
  },
});
voiceRef = voice;
voice.lang = locale.get();
locale.subscribe((lang) => {
  voice.lang = lang;
  // An explicit interface-language choice also retargets speech recognition
  // — persisted, or a reload would resurrect the auto-learned value. A
  // pinned speech language (speechLangMode en/ar) always wins.
  if ((prefs.get('speechLangMode') || 'auto') === 'auto') {
    voice.speechLang = lang;
    prefs.set('speechLang', lang);
  }
});

function setReplyText(text) {
  const line = $('replyLine');
  if (line.firstChild?.nodeType === Node.TEXT_NODE) line.firstChild.data = text;
  else mount(line, text);
}
$('replyLine').addEventListener('click', () => $('replyLine').classList.toggle('expanded'));

/* ---------- typed input shares the same conversation ---------- */
async function sendTyped(text) {
  conversation.addUser(text);
  langOffer.note(text);
  assistantUpdate = conversation.beginAssistant();
  await voice.sendText(text, 'text');
  void cards.render();
}

/* ---------- UI modules ---------- */
const inspector = buildInspector({
  backend,
  onError: (msg) => conversation.addSystem(`⚠ ${msg}`),
});

const chat = buildChat({ conversation, onSend: sendTyped });

const activity = buildActivity({
  backend,
  onError: (msg) => conversation.addSystem(`⚠ ${msg}`),
  onInspect: (target) => inspector.select(target),
});

const cards = buildCards({
  backend,
  langOffer,
  onAction: async (path, body) => {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) conversation.addSystem(`⚠ ${data?.error?.message ?? res.status}`);
    await backend.refresh();
    void cards.render();
    void activity.render();
  },
  onInspect: (target) => inspector.select(target),
});

const palette = buildPalette({
  onAsk: (text) => {
    openDrawer($('chatOv'), $('chatDrawer'));
    void sendTyped(text);
  },
  onNavigate: (id) => {
    if (id === 'chat') openDrawer($('chatOv'), $('chatDrawer'));
    else if (id === 'activity') { void activity.render(); openDrawer($('actOv'), $('actDrawer')); }
    else if (id === 'language') locale.toggle();
    else if (id === 'replyLang') {
      const order = ['auto', 'en', 'ar'];
      const next = order[(order.indexOf(prefs.get('replyLang') || 'auto') + 1) % order.length];
      prefs.set('replyLang', next);
      conversation.addSystem(`🗣 ${t('palette.nav.replyLang', { mode: t(`replyLang.${next}`) })}`);
    }
    else if (id === 'speechLang') {
      // What language SIRA LISTENS for. Pinning it ends auto-learning — the
      // deterministic escape from a wrong learned recognition language.
      const order = ['auto', 'en', 'ar'];
      const next = order[(order.indexOf(prefs.get('speechLangMode') || 'auto') + 1) % order.length];
      prefs.set('speechLangMode', next);
      if (next === 'en' || next === 'ar') {
        voice.speechLang = next;
        prefs.set('speechLang', next);
      }
      conversation.addSystem(`🎙 ${t('palette.nav.speechLang', { mode: t(`speechLang.${next}`) })}`);
    }
    else if (id === 'delegation') {
      // Owner toggle: OFF = SIRA never delegates — one voice, works alone
      // (enforced at the runtime tool gate, not just by prompt text).
      const next = prefs.get('delegation') === 'off' ? 'on' : 'off';
      prefs.set('delegation', next);
      conversation.addSystem(`⚙ ${t('palette.nav.delegation', { mode: t(`toggle.${next}`) })}`);
    }
    else if (id === 'continuous') {
      // Continuous conversation: after SIRA finishes speaking, the mic
      // reopens automatically for the next turn.
      const next = !prefs.bool('continuous');
      voice.setContinuous(next);
      conversation.addSystem(`⚙ ${t('palette.nav.continuous', { mode: t(`toggle.${next ? 'on' : 'off'}`) })}`);
    }
    else if (id === 'autopilot') {
      // Continuous company operation: plans auto-confirm and (with a standing
      // directive set) idle periods open new work cycles. Server-side state.
      void (async () => {
        const next = backend.snapshot?.autopilot ? 'off' : 'on';
        const res = await fetch('/api/settings/autopilot', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: next }),
        });
        if (res.ok) {
          await backend.refresh();
          conversation.addSystem(`⚙ ${t('palette.nav.autopilot', { mode: t(`toggle.${next}`) })}`);
        }
      })();
    }
    else if (id === 'motion') {
      prefs.set('motion', prefs.get('motion') === 'reduced' ? 'full' : 'reduced');
      applyMotionAttr();
    }
  },
  onOpenResult: (r) => {
    if (r.type === 'task') inspector.select({ kind: 'task', id: r.id });
    else if (r.type === 'agent') inspector.select({ kind: 'agent', key: r.id });
    else if (r.type === 'objective') { void activity.render(); openDrawer($('actOv'), $('actDrawer')); }
    else if (r.type === 'artifact') window.open(`/api/artifacts/${r.id}/content`, '_blank', 'noopener');
    else if (r.type === 'approval') { void activity.render(); openDrawer($('actOv'), $('actDrawer')); }
    else if (r.type === 'conversation' || r.type === 'message') openDrawer($('chatOv'), $('chatDrawer'));
    else { void activity.render(); openDrawer($('actOv'), $('actDrawer')); }
  },
});

/* ---------- shell ---------- */
buildHeader({ onLang: () => locale.toggle() });
buildControls({
  onMute: () => setMuted(voice.toggleMute()),
  onChat: () => toggleDrawer($('chatOv'), $('chatDrawer')),
  onTalk: ({ hold, phase }) => {
    if (hold && phase === 'start') voice.holdStart();
    else if (hold && phase === 'end') voice.holdEnd();
    else void voice.talk();
  },
  onSearch: () => palette.open('ask'),
  onActivity: () => toggleDrawer($('actOv'), $('actDrawer'), () => void activity.render()),
  onStop: () => voice.stopGeneration(),
});
$('chatOv').addEventListener('click', () => closeDrawer($('chatOv'), $('chatDrawer')));
$('actOv').addEventListener('click', () => closeDrawer($('actOv'), $('actDrawer')));
bindKey(isPaletteKey, () => palette.open('ask'));

/* ---------- neural network + core ---------- */
const network = new NetworkGraph($('network'), {
  backend,
  onSelect: (target) => {
    if (target.kind === 'core') { void activity.render(); openDrawer($('actOv'), $('actDrawer')); }
    else inspector.select(target);
  },
});

new SiraCore($('core'), () => ({
  state: currentCoreState,
  amplitude: voice.amplitude(),
  executing: backend.runningExecutions(),
  approvals: backend.pendingApprovals(),
}));

// Shared rAF for pulse travel (presentation of real events only).
(function pulseLoop(now) {
  network.step(now ?? performance.now());
  requestAnimationFrame(pulseLoop);
})();

/* ---------- composite core state ---------- */
function updateCoreState() {
  const derived = deriveCoreState({
    voiceState: voiceRef?.state ?? 'initializing',
    connected: backend.connected,
    reconnecting: backend.reconnecting,
    workerFresh: backend.workerFresh(),
    runningExecutions: backend.runningExecutions(),
    pendingApprovals: backend.pendingApprovals(),
    ring: backend.ring,
    snapshot: backend.snapshot,
    now: Date.now(),
  });
  currentCoreState = derived.state;
  const label = $('voiceState');
  label.textContent = t(`state.${derived.state}`);
  label.dataset.state = derived.state;
  label.dataset.source = derived.source;
  if (derived.seq) label.dataset.seq = String(derived.seq);
  $('syncWarn').hidden = derived.state !== 'sync_lost';
  if (derived.state === 'sync_lost') $('syncWarn').textContent = t('network.syncLost');
}
registerRegion(updateCoreState);

/* ---------- backend subscriptions ---------- */
backend.subscribe(() => {
  updateCoreState();
  renderHeaderState({
    connected: backend.connected,
    backendReachable: backend.snapshot !== null,
    workerFresh: backend.workerFresh(),
    adapter: backend.health?.adapter,
    micState: voiceRef?.state === 'muted' ? 'muted' : voiceRef?.capture.active ? 'live' : 'off',
  });
  setApprovalCount(backend.pendingApprovals());
  // Who is working RIGHT NOW: live SDK delegations by name (so the owner
  // always knows which agent is thinking/working), else the worker count.
  const sdkAgents = backend.sdkActiveAgents();
  if (sdkAgents.size > 0) {
    const roster = backend.snapshot?.agents ?? [];
    const label = [...sdkAgents.entries()].map(([key, entry]) => {
      const agent = roster.find((a) => a.key === key);
      const name = (document.documentElement.lang === 'ar' ? agent?.nameAr : agent?.nameEn) ?? key;
      return entry.status === 'using_tool' ? `${name} — ${t('state.using_tool')}` : name;
    }).join(' · ');
    $('execLine').textContent = label;
  } else {
    const executing = backend.runningExecutions();
    $('execLine').textContent = executing > 0 ? execCountLabel(executing) : '';
  }
  // Deployed a new interface build? Reload ONCE so the owner never runs
  // stale code (the historical source of "long-fixed" bugs reappearing).
  const build = backend.health?.build;
  if (build && bootBuild && build !== bootBuild && sessionStorage.getItem('sira.reloadedBuild') !== build) {
    sessionStorage.setItem('sira.reloadedBuild', build);
    location.reload();
  }
  void network.render();
});

backend.on('plan.proposed', (ev) => {
  conversation.addSystem(`📋 ${t('chat.planReady', { reply: ev.payload?.reply ?? '' })}`);
  void cards.render();
  void activity.render();
});
backend.on('objective.finished', (ev) => {
  const status = ev.payload?.status;
  conversation.addSystem(
    status === 'completed' ? `✅ ${t('chat.objectiveCompleted')}`
    : status === 'cancelled' ? `⏹ ${t('chat.objectiveCancelled')}`
    : `❌ ${t('chat.objectiveFailed')}`,
  );
  announcer.say(
    status === 'completed' ? t('announce.objectiveCompleted')
    : status === 'cancelled' ? t('announce.objectiveCancelled')
    : t('announce.executionFailed'),
  );
  void cards.render();
});
backend.on('approval.requested', (ev) => {
  conversation.addSystem(`✋ ${t('chat.needsApproval', { subject: ev.payload?.subject ?? '' })}`);
  announcer.say(t('announce.approvalRequired'));
  void cards.render();
  void activity.render();
});
backend.on('notification.created', () => void cards.render());
backend.on('artifact.created', () => void cards.render());
backend.on('task.status', (ev) => {
  if (ev.payload?.to === 'failed') announcer.say(t('announce.executionFailed'));
});

/* ---------- boot ---------- */
// Debug/test handle — read-only introspection of the live stores.
window.sira = { backend, conversation, voice, get coreState() { return currentCoreState; } };

let bootBuild = null;
(async () => {
  document.body.classList.add('booted');
  try {
    await backend.refresh();
    bootBuild = backend.health?.build ?? null;
    backend.connect();
  } catch {
    renderHeaderState({ connected: false, backendReachable: false, workerFresh: false, adapter: null, micState: 'off' });
  }
  await conversation.resync();
  await voice.init();
  updateCoreState();
  void cards.render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
