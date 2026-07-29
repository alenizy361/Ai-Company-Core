// Phase-1 shell: renders ONLY persisted backend state. State = f(snapshot, SSE
// events); no timers ever fabricate activity. Replaced by the full voice-first
// client in later phases, which reuses this snapshot+events pattern.

const connBadge = document.getElementById('connBadge');
const workerBadge = document.getElementById('workerBadge');
const adapterNote = document.getElementById('adapterNote');
const agentsEl = document.getElementById('agents');
const metaEl = document.getElementById('meta');

let state = null;
let lastSeq = 0;
let eventSource = null;

function render() {
  if (!state) return;
  workerBadge.hidden = false;
  workerBadge.textContent = state.workerFresh ? 'WORKER ONLINE' : 'WORKER OFFLINE';
  workerBadge.className = 'badge ' + (state.workerFresh ? 'live' : 'offline');

  agentsEl.innerHTML = '';
  for (const agent of state.agents) {
    const li = document.createElement('li');
    li.className = 'st-' + agent.status;
    li.innerHTML = `<span class="dot"></span><b>${agent.short}</b> ${agent.nameEn}<span>${agent.status}</span>`;
    agentsEl.appendChild(li);
  }
  const counts = Object.entries(state.taskCounts || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'none';
  metaEl.textContent = `tasks — ${counts} | objectives: ${state.objectives.length} | pending approvals: ${state.pendingApprovals} | last event seq: ${lastSeq}`;
}

async function loadSnapshot() {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error(`state ${res.status}`);
  state = await res.json();
  lastSeq = state.lastSeq;
  render();
}

async function loadHealth() {
  try {
    const res = await fetch('/api/health');
    const health = await res.json();
    const adapter = health.adapter || {};
    if (adapter.name === 'mock') {
      adapterNote.textContent = `MOCK MODE — ${adapter.reason}`;
      adapterNote.style.color = 'var(--amber)';
    } else {
      adapterNote.textContent = `model: ${adapter.name}`;
    }
  } catch { /* health shown as disconnected by badge */ }
}

function connectEvents() {
  eventSource = new EventSource(`/api/events?since=${lastSeq}`);
  eventSource.onopen = () => {
    connBadge.textContent = 'LIVE';
    connBadge.className = 'badge live';
  };
  eventSource.onerror = () => {
    connBadge.textContent = 'DISCONNECTED';
    connBadge.className = 'badge offline';
    // EventSource auto-reconnects; on reconnect we refetch the snapshot to
    // close any gap (Last-Event-ID replay covers the stream side).
  };
  eventSource.onmessage = onEvent;
  // Named events also arrive; a generic listener via onmessage misses them,
  // so re-dispatch anything with an id through one handler.
  const relay = (ev) => onEvent(ev);
  for (const type of ['task.status', 'execution.started', 'execution.finished', 'worker.heartbeat', 'worker.online', 'worker.offline', 'tool.denied', 'approval.requested']) {
    eventSource.addEventListener(type, relay);
  }
}

let refreshQueued = false;
function onEvent(ev) {
  if (ev.lastEventId) lastSeq = Number(ev.lastEventId);
  // Phase-1 shell: any persisted event triggers a snapshot refresh (coalesced).
  if (!refreshQueued) {
    refreshQueued = true;
    setTimeout(async () => {
      refreshQueued = false;
      try { await loadSnapshot(); } catch { /* badge already shows disconnect */ }
    }, 300);
  }
}

(async () => {
  try {
    await loadSnapshot();
    await loadHealth();
    connectEvents();
  } catch (err) {
    connBadge.textContent = 'BACKEND UNREACHABLE';
    connBadge.className = 'badge offline';
    metaEl.textContent = String(err);
  }
})();
