// RABIT voice-first client. Every visible datum derives from: (a) the backend
// snapshot + persisted SSE events, or (b) real voice-session signals (mic,
// synthesis, model requests). Nothing is animated or labeled without a source.
import { BackendStore } from './store.js';
import { VoiceController } from './voice/controller.js';
import { Orb } from './voice/orb.js';

const $ = (id) => document.getElementById(id);
const backend = new BackendStore();

const STATE_LABELS = {
  ar: {
    initializing: 'جارٍ التجهيز', permission_required: 'يحتاج إذن المايك', ready: 'جاهز',
    listening: 'أستمع…', detecting_end_of_turn: 'أستمع…', transcribing: 'أفرّغ الكلام…',
    thinking: 'أفكّر…', calling_tool: 'أستخدم أداة…', creating_plan: 'أجهّز خطة…',
    executing: 'الفريق يعمل', waiting_for_approval: 'بانتظار موافقتك',
    generating_speech: 'أجهّز الرد…', speaking: 'أتحدث', interrupted: 'تفضّل…',
    connecting: 'اتصال…', reconnecting: 'إعادة اتصال…', muted: 'المايك مكتوم',
    offline: 'غير متصل', failed: 'عطل — راجع الحالة', wake_word_listening: 'أنتظر النداء',
  },
  en: {
    initializing: 'INITIALIZING', permission_required: 'MIC PERMISSION NEEDED', ready: 'READY',
    listening: 'LISTENING…', detecting_end_of_turn: 'LISTENING…', transcribing: 'TRANSCRIBING…',
    thinking: 'THINKING…', calling_tool: 'USING A TOOL…', creating_plan: 'DRAFTING A PLAN…',
    executing: 'TEAM WORKING', waiting_for_approval: 'AWAITING YOUR APPROVAL',
    generating_speech: 'PREPARING SPEECH…', speaking: 'SPEAKING', interrupted: 'GO AHEAD…',
    connecting: 'CONNECTING…', reconnecting: 'RECONNECTING…', muted: 'MIC MUTED',
    offline: 'OFFLINE', failed: 'FAILED — CHECK STATUS', wake_word_listening: 'WAKE WORD ARMED',
  },
};

let lang = localStorage.getItem('rabit.lang') || 'ar';

let voiceRef = null; // assigned right after construction; onStateChange fires during it
const voice = new VoiceController({
  onStateChange(state) {
    $('voiceState').textContent = (STATE_LABELS[lang] ?? STATE_LABELS.en)[state] ?? state;
    $('micDot').classList.toggle('on', ['listening', 'detecting_end_of_turn', 'transcribing'].includes(state));
    const micLive = voiceRef?.capture.active ?? false;
    $('micBadge').textContent = state === 'muted' ? 'MIC MUTED' : micLive ? 'MIC LIVE' : 'MIC OFF';
    $('micBadge').className = 'badge ' + (state === 'muted' ? 'off' : micLive ? 'warn' : 'dim');
  },
  onTranscript(text, isFinal) {
    $('transcriptLine').textContent = text;
    if (isFinal) addChat(text, true);
  },
  onReply(text, { interrupted } = {}) {
    $('replyLine').textContent = text;
    if (!interrupted) updateLastAiChat(text);
    else addChat(text, false, 'unspoken remainder (you interrupted)');
  },
  onRoute(data) {
    if (data.route === 'create_objective' && data.objectiveId) {
      addChat(lang === 'ar' ? '📋 تم إنشاء الهدف — سيصلك عرض الخطة هنا للموافقة.' : '📋 Objective created — the plan proposal will appear here for confirmation.', false);
    }
  },
  onError(message, { preserveText } = {}) {
    addChat(`⚠ ${message}`, false);
    if (preserveText) $('chatInp').value = preserveText; // offline: keep the unsent text
  },
});

voiceRef = voice;
voice.lang = lang;

/* ---------- chat drawer (secondary interface; same conversation) ---------- */
let lastAiBubble = null;
function addChat(text, me, tech) {
  const el = document.createElement('div');
  el.className = 'msg ' + (me ? 'me' : 'ai');
  el.textContent = text;
  if (tech) {
    const t = document.createElement('div');
    t.className = 'tech';
    t.textContent = tech;
    el.appendChild(t);
  }
  $('chatMsgs').appendChild(el);
  $('chatMsgs').scrollTop = $('chatMsgs').scrollHeight;
  if (!me) lastAiBubble = el;
  else lastAiBubble = null;
}
function updateLastAiChat(text) {
  if (lastAiBubble) lastAiBubble.firstChild.textContent = text;
  else addChat(text, false);
}

async function sendTyped() {
  const text = $('chatInp').value.trim();
  if (!text) return;
  $('chatInp').value = '';
  addChat(text, true);
  await voice.sendText(text, 'text');
}
$('chatSend').onclick = sendTyped;
$('chatInp').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendTyped(); });

/* ---------- controls ---------- */
$('talkBtn').onclick = () => voice.talk();
$('muteBtn').onclick = () => {
  const muted = voice.toggleMute();
  $('talkBtn').classList.toggle('muted', muted);
  $('muteBtn').textContent = muted ? '🔈' : '🔇';
};
$('langBtn').onclick = () => {
  lang = lang === 'ar' ? 'en' : 'ar';
  localStorage.setItem('rabit.lang', lang);
  voice.lang = lang;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  $('langBtn').textContent = lang === 'ar' ? 'EN' : 'ع';
  $('chatInp').placeholder = lang === 'ar' ? 'اكتب لرابِت…' : 'Type to RABIT…';
};

function drawerToggle(ov, drawer, open) {
  $(ov).classList.toggle('open', open);
  $(drawer).classList.toggle('open', open);
}
$('chatBtn').onclick = () => drawerToggle('chatOv', 'chatDrawer', true);
$('chatOv').onclick = () => drawerToggle('chatOv', 'chatDrawer', false);
$('activityBtn').onclick = () => { renderActivity(); drawerToggle('actOv', 'actDrawer', true); };
$('approvalsBtn').onclick = () => { renderActivity(); drawerToggle('actOv', 'actDrawer', true); $('secApprovals').scrollIntoView({ block: 'center' }); };
$('actOv').onclick = () => drawerToggle('actOv', 'actDrawer', false);

/* ---------- orb ---------- */
new Orb($('orb'), () => ({
  state: voice.state,
  amplitude: voice.amplitude(),
  executing: backend.runningExecutions(),
  approvals: backend.pendingApprovals(),
}));

/* ---------- backend-truth rendering ---------- */
function chip(status) {
  return `<span class="chip ${status}">${status}</span>`;
}

async function actApi(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) addChat(`⚠ ${data?.error?.message ?? res.status}`, false);
  await backend.refresh();
  renderActivity();
}

async function renderActivity() {
  const s = backend.snapshot;
  if (!s) return;
  const fresh = backend.workerFresh();

  // Plans awaiting confirmation
  const plans = [];
  for (const objective of s.objectives.filter((o) => o.status === 'plan_proposed').slice(0, 5)) {
    try {
      const detail = await (await fetch(`/api/objectives/${objective.id}`)).json();
      for (const plan of (detail.plans ?? []).filter((p) => p.status === 'proposed')) {
        const steps = Array.isArray(plan.raw_json?.plan) ? plan.raw_json.plan : [];
        plans.push(`<div class="card"><div class="row"><b class="grow">${objective.title}</b>${chip('queued')}</div>
          <small>${plan.reply ?? ''}</small>
          <small>${steps.map((st) => `${st.agent}: ${st.title}`).join(' → ') || 'no execution steps (answer only)'}</small>
          <div class="row" style="margin-top:8px">
            <button class="sbtn ok" data-confirm="${plan.id}">✓ Confirm</button>
            <button class="sbtn danger" data-rejectplan="${plan.id}">✗ Reject</button>
          </div></div>`);
      }
    } catch { /* detail fetch failed; snapshot refresh will retry */ }
  }
  $('secPlans').innerHTML = plans.join('') || '<div class="empty">none</div>';

  const running = fresh ? s.runningExecutions : [];
  $('secRunning').innerHTML = running.map((e) =>
    `<div class="card"><div class="row"><b class="grow">${e.agent_key}</b>${chip(e.status)}</div>
     <small>execution ${e.id} · started ${new Date(e.started_at).toLocaleTimeString()} · ${e.turns_used} turns</small></div>`,
  ).join('') || `<div class="empty">${fresh ? 'nothing executing' : 'worker offline — nothing can execute'}</div>`;

  try {
    const approvals = await (await fetch('/api/approvals?status=pending')).json();
    $('apprCnt').hidden = approvals.length === 0;
    $('apprCnt').textContent = approvals.length;
    $('secApprovals').innerHTML = approvals.map((a) =>
      `<div class="card"><div class="row"><b class="grow">${a.summary}</b></div>
       <div class="row" style="margin-top:8px">
         <button class="sbtn ok" data-approve="${a.id}">✓ Approve</button>
         <button class="sbtn danger" data-rejectappr="${a.id}">✗ Reject</button>
       </div></div>`,
    ).join('') || '<div class="empty">none</div>';
  } catch { /* keep previous */ }

  const counts = s.taskCounts ?? {};
  $('secWaiting').innerHTML = ['queued', 'waiting_for_dependency', 'blocked', 'waiting_for_approval']
    .filter((k) => counts[k]).map((k) => `<div class="card"><div class="row">${chip(k)}<b>${counts[k]}</b></div></div>`)
    .join('') || '<div class="empty">none</div>';

  try {
    const failures = await (await fetch('/api/failures')).json();
    $('secFailed').innerHTML = failures.failedTasks.slice(0, 8).map((t) =>
      `<div class="card"><div class="row"><b class="grow">${t.title}</b>${chip(t.status)}</div>
       <small>${t.agent_key} · attempt ${t.attempt_count}/${t.max_attempts} · ${t.blocker ?? ''}</small>
       <div class="row" style="margin-top:6px"><button class="sbtn" data-retry="${t.id}">↻ Retry</button></div></div>`,
    ).join('') || '<div class="empty">none</div>';
  } catch { /* keep previous */ }

  $('secDone').innerHTML = s.objectives.filter((o) => ['completed', 'failed'].includes(o.status)).slice(0, 6)
    .map((o) => `<div class="card"><div class="row"><b class="grow">${o.title}</b>${chip(o.status)}</div></div>`)
    .join('') || '<div class="empty">none</div>';

  $('agentsGrid').innerHTML = s.agents.map((a) =>
    `<div class="card"><div class="row"><b class="grow">${a.short}</b>${chip(a.status)}</div><small>${a.nameEn}</small></div>`,
  ).join('');

  const h = backend.health;
  $('secHealth').innerHTML = h ? `<div class="card">
    <small>db: ${h.db?.ok ? 'ok' : 'FAILED'} · worker: ${h.worker?.online ? `online (${h.worker.count})` : 'OFFLINE'} ·
    model: ${h.adapter?.name} (${h.adapter?.reason}) · voice: stt=${h.voiceProviders?.stt} tts=${h.voiceProviders?.tts}
    wake=${h.voiceProviders?.wake} transport=${h.voiceProviders?.transport} · pending approvals: ${h.pendingApprovals}</small>
  </div>` : '<div class="empty">health unavailable</div>';

  $('eventFeed').innerHTML = backend.eventLog.slice(-40).reverse()
    .map((e) => `${new Date(e.at).toLocaleTimeString()} ${e.type} ${e.agentKey ?? ''} ${e.payload?.to ?? e.payload?.tool ?? ''}`)
    .join('<br>');
}

$('actDrawer').addEventListener('click', (e) => {
  const t = e.target;
  if (t.dataset.confirm) actApi(`/api/plans/${t.dataset.confirm}/confirm`);
  else if (t.dataset.rejectplan) actApi(`/api/plans/${t.dataset.rejectplan}/reject`, { reason: 'rejected from board' });
  else if (t.dataset.approve) actApi(`/api/approvals/${t.dataset.approve}/decide`, { decision: 'approved', via: 'ui' });
  else if (t.dataset.rejectappr) actApi(`/api/approvals/${t.dataset.rejectappr}/decide`, { decision: 'rejected', via: 'ui' });
  else if (t.dataset.retry) actApi(`/api/tasks/${t.dataset.retry}/retry`);
});

/* ---------- header truth badges + notifications ---------- */
function renderHeader() {
  $('connBadge').textContent = backend.connected ? 'LIVE' : 'DISCONNECTED';
  $('connBadge').className = 'badge ' + (backend.connected ? 'live' : 'off');
  const fresh = backend.workerFresh();
  $('workerBadge').textContent = fresh ? 'WORKER ONLINE' : 'WORKER OFFLINE';
  $('workerBadge').className = 'badge ' + (fresh ? 'live' : 'off');
  const adapter = backend.health?.adapter;
  if (adapter?.name === 'mock') {
    $('adapterBadge').hidden = false;
    $('banner').style.display = 'block';
    $('banner').textContent = `MOCK MODE — no real model configured (${adapter.reason})`;
  } else {
    $('adapterBadge').hidden = true;
    $('banner').style.display = 'none';
  }
  const executing = backend.runningExecutions();
  $('execLine').textContent = executing
    ? (lang === 'ar' ? `${executing} مهمة قيد التنفيذ` : `${executing} task${executing > 1 ? 's' : ''} executing`)
    : '';
}

backend.subscribe(() => {
  renderHeader();
  // Meaningful events announce themselves in chat (never spoken unprompted).
  const latest = backend.eventLog[backend.eventLog.length - 1];
  if (latest && latest.seq !== renderHeader._lastAnnounced) {
    renderHeader._lastAnnounced = latest.seq;
    if (latest.type === 'plan.proposed') {
      addChat(lang === 'ar'
        ? `📋 خطة جاهزة للمراجعة: ${latest.payload?.reply ?? ''}`
        : `📋 Plan ready for review: ${latest.payload?.reply ?? ''}`, false);
      renderActivity();
    } else if (latest.type === 'objective.finished') {
      addChat(latest.payload?.status === 'completed'
        ? (lang === 'ar' ? '✅ اكتمل الهدف.' : '✅ Objective completed.')
        : (lang === 'ar' ? '❌ فشل الهدف — راجع لوحة النشاط.' : '❌ Objective failed — check the activity board.'), false);
    } else if (latest.type === 'approval.requested') {
      addChat(lang === 'ar' ? `✋ يحتاج موافقتك: ${latest.payload?.subject ?? ''}` : `✋ Needs your approval: ${latest.payload?.subject ?? ''}`, false);
      renderActivity();
    }
  }
});

/* ---------- boot ---------- */
(async () => {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  $('langBtn').textContent = lang === 'ar' ? 'EN' : 'ع';
  try {
    await backend.refresh();
    backend.connect();
  } catch {
    $('connBadge').textContent = 'BACKEND UNREACHABLE';
    $('connBadge').className = 'badge off';
  }
  await voice.init();
  renderHeader();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
