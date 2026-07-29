// Client mirror of the voice session state machine. Same source-attribution
// rule as the server: a module may only claim states it owns. Every accepted
// transition is also reported to the backend, which validates independently
// and records invalid attempts.
const STATE_SOURCES = {
  initializing: ['client_boot'],
  permission_required: ['capture'],
  ready: ['client_boot', 'capture', 'playback', 'server', 'stt', 'tts', 'wake'],
  wake_word_listening: ['wake'],
  connecting: ['transport'],
  listening: ['capture'],
  detecting_end_of_turn: ['turn_detector'],
  transcribing: ['stt'],
  thinking: ['server'],
  calling_tool: ['server'],
  creating_plan: ['server'],
  executing: ['server'],
  waiting_for_approval: ['server'],
  generating_speech: ['tts'],
  speaking: ['playback'],
  interrupted: ['capture', 'playback'],
  reconnecting: ['transport'],
  muted: ['capture'],
  offline: ['transport', 'client_boot'],
  failed: ['capture', 'stt', 'tts', 'transport', 'server'],
};

export class VoiceStateStore {
  constructor() {
    this.state = 'initializing';
    this.session = null; // {id, token}
    this.listeners = new Set();
    this.log = [];
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.state, null);
    return () => this.listeners.delete(fn);
  }

  /** Transition claimed by a source module. Rejects fabricated states locally;
   * reports accepted ones to the backend (which re-validates). */
  transition(to, source) {
    const allowed = STATE_SOURCES[to];
    if (!allowed || !allowed.includes(source)) {
      console.warn(`[voice] rejected local transition to ${to} from source ${source}`);
      return false;
    }
    const from = this.state;
    if (from === to) return true;
    this.state = to;
    this.log.push({ from, to, source, ts: Date.now() });
    for (const fn of this.listeners) fn(to, from);
    if (this.session) {
      fetch(`/api/voice-session/${this.session.id}/transition`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to, source, token: this.session.token }),
        keepalive: true,
      }).catch(() => { /* transition reporting is best-effort */ });
    }
    return true;
  }

  /** Apply a server-announced state locally (the server already validated and
   * recorded it — mirroring is not claiming, so nothing is reported back). */
  mirror(to) {
    if (!STATE_SOURCES[to]) return;
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.log.push({ from, to, source: 'server_mirror', ts: Date.now() });
    for (const fn of this.listeners) fn(to, from);
  }

  async openSession() {
    const res = await fetch('/api/voice-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientKind: 'web' }),
    });
    if (!res.ok) throw new Error(`voice session: ${res.status}`);
    const data = await res.json();
    this.session = { id: data.id, token: data.token };
    this.turnConfig = data.turn;
    return data;
  }

  reportMetrics(metrics) {
    if (!this.session) return;
    fetch(`/api/voice-session/${this.session.id}/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: this.session.token, metrics }),
      keepalive: true,
    }).catch(() => {});
  }
}
