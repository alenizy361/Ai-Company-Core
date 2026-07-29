// Backend-truth store: state = reduce(GET /api/state snapshot, SSE events).
// The staleness rule lives here: without a fresh worker heartbeat event, no
// agent may render as running — offline is derived, never guessed.
export class BackendStore {
  constructor() {
    this.snapshot = null;
    this.health = null;
    this.lastSeq = 0;
    this.lastHeartbeatAt = 0;
    this.connected = false;
    this.listeners = new Set();
    this.eventLog = []; // recent events for the activity feed
    this.es = null;
    this._refreshQueued = false;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify() {
    for (const fn of this.listeners) fn(this);
  }

  /** Honest worker view: heartbeat events within 90s, else offline. */
  workerFresh() {
    if (this.lastHeartbeatAt > Date.now() - 90000) return true;
    return !!this.snapshot?.workerFresh && (this._snapshotAt ?? 0) > Date.now() - 90000;
  }

  runningExecutions() {
    return this.workerFresh() ? (this.snapshot?.runningExecutions?.length ?? 0) : 0;
  }

  pendingApprovals() {
    return this.snapshot?.pendingApprovals ?? 0;
  }

  async refresh() {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error(`state ${res.status}`);
    this.snapshot = await res.json();
    this._snapshotAt = Date.now();
    this.lastSeq = Math.max(this.lastSeq, this.snapshot.lastSeq);
    if (this.snapshot.workerFresh) this.lastHeartbeatAt = Date.now();
    try {
      this.health = await (await fetch('/api/health')).json();
    } catch { this.health = null; }
    this._notify();
  }

  connect() {
    this.es = new EventSource(`/api/events?since=${this.lastSeq}`);
    this.es.onopen = () => { this.connected = true; this._notify(); };
    this.es.onerror = () => { this.connected = false; this._notify(); };
    const handle = (ev) => {
      if (ev.lastEventId) this.lastSeq = Number(ev.lastEventId);
      let data = null;
      try { data = JSON.parse(ev.data); } catch { return; }
      if (data.type === 'worker.heartbeat' || data.type === 'worker.online') this.lastHeartbeatAt = Date.now();
      if (data.type !== 'worker.heartbeat') {
        this.eventLog.push(data);
        if (this.eventLog.length > 200) this.eventLog.shift();
      }
      this._queueRefresh();
      this._notify();
    };
    this.es.onmessage = handle;
    for (const type of [
      'task.status', 'task.created', 'task.note', 'execution.started', 'execution.finished', 'execution.verifying',
      'verification.result', 'tool.succeeded', 'tool.failed', 'tool.denied', 'approval.requested', 'approval.decided',
      'plan.proposed', 'plan.confirmed', 'plan.rejected', 'plan.validation_failed', 'planning.started',
      'planning.exhausted', 'planning.adapter_error', 'objective.created', 'objective.finished',
      'worker.heartbeat', 'worker.online', 'worker.offline', 'handoff.created', 'model.validation_failed',
    ]) {
      this.es.addEventListener(type, handle);
    }
    // Staleness re-render tick: no data is invented — this only re-evaluates
    // heartbeat age so a dead worker visibly goes offline.
    setInterval(() => this._notify(), 15000);
  }

  _queueRefresh() {
    if (this._refreshQueued) return;
    this._refreshQueued = true;
    setTimeout(async () => {
      this._refreshQueued = false;
      try { await this.refresh(); } catch { this.connected = false; this._notify(); }
    }, 250);
  }
}
