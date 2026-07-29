// Backend-truth store v2: state = reduce(GET /api/state snapshot, SSE events).
// The debounced full-snapshot refetch remains the honesty backbone; on top of
// it sits a typed event ring + bus that powers network pulses, cards, the
// composite core state, and announcements. Staleness rule unchanged: without
// a fresh worker heartbeat, nothing may render as running.
import { EventStream } from './sse.js';
import { deriveSdkActivity } from './core-state.js';

const RING_CAP = 500;

export class BackendStore {
  constructor() {
    this.snapshot = null;
    this.health = null;
    this.lastSeq = 0;
    this.lastHeartbeatAt = 0;
    this.connected = false;
    this.reconnecting = false;
    this.listeners = new Set();
    this.typed = new Map(); // event type -> Set<fn>, '*' for all
    this.ring = [];
    this._refreshQueued = false;
    this._objectiveCache = new Map(); // id -> {at, data}
    this.stream = null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Typed event bus over the ring: on('handoff.created', fn) or on('*', fn). */
  on(type, fn) {
    if (!this.typed.has(type)) this.typed.set(type, new Set());
    this.typed.get(type).add(fn);
    return () => this.typed.get(type)?.delete(fn);
  }

  _notify() {
    for (const fn of this.listeners) fn(this);
  }

  _emit(ev) {
    for (const fn of this.typed.get(ev.type) ?? []) fn(ev);
    for (const fn of this.typed.get('*') ?? []) fn(ev);
  }

  /**
   * Honest worker view. A fresh snapshot is authoritative — the server
   * derives staleness from real heartbeat rows, and a newer snapshot must
   * out-vote the client's own heartbeat memory (a SIGKILLed worker emits
   * nothing; only the server notices).
   */
  workerFresh() {
    const snapAt = this._snapshotAt ?? 0;
    if (snapAt > Date.now() - 90000 && snapAt >= this.lastHeartbeatAt) {
      return !!this.snapshot?.workerFresh;
    }
    return this.lastHeartbeatAt > Date.now() - 90000;
  }

  runningExecutions() {
    return this.workerFresh() ? (this.snapshot?.runningExecutions?.length ?? 0) : 0;
  }

  pendingApprovals() {
    return this.snapshot?.pendingApprovals ?? 0;
  }

  /** Agent-SDK subagent activity (from persisted sira.* events — real, seq-tagged). */
  sdkActiveAgents() {
    return deriveSdkActivity(this.ring, Date.now());
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
    this.stream = new EventStream('/api/events', {
      sinceProvider: () => this.lastSeq,
      onStatus: (status) => {
        this.connected = status === 'connected';
        this.reconnecting = status === 'reconnecting';
        if (this.connected) this._queueRefresh(); // resync after any gap
        this._notify();
      },
      onEvent: (ev) => {
        if (typeof ev.seq === 'number') this.lastSeq = Math.max(this.lastSeq, ev.seq);
        if (ev.type === 'worker.heartbeat' || ev.type === 'worker.online') this.lastHeartbeatAt = Date.now();
        if (ev.type !== 'worker.heartbeat') {
          this.ring.push(ev);
          if (this.ring.length > RING_CAP) this.ring.shift();
          // Any event touching an objective invalidates its cached detail.
          if (ev.type.startsWith('plan') || ev.type.startsWith('objective') || ev.taskId) {
            this._objectiveCache.clear();
          }
        }
        this._emit(ev);
        this._queueRefresh();
        this._notify();
      },
    });
    this.stream.start();
    // Idle tick: re-poll the snapshot so silent worker death (no events) still
    // surfaces within one tick, and re-evaluate heartbeat age for rendering.
    setInterval(() => {
      this._queueRefresh();
      this._notify();
    }, 15000);
  }

  _queueRefresh() {
    if (this._refreshQueued) return;
    this._refreshQueued = true;
    setTimeout(async () => {
      this._refreshQueued = false;
      try { await this.refresh(); } catch { this._notify(); }
    }, 250);
  }

  /** Cached DAG detail for the network view (tasks + dependencies + plans). */
  async objectiveDetail(id) {
    const cached = this._objectiveCache.get(id);
    if (cached && cached.at > Date.now() - 5000) return cached.data;
    const res = await fetch(`/api/objectives/${id}`);
    if (!res.ok) throw new Error(`objective ${res.status}`);
    const data = await res.json();
    this._objectiveCache.set(id, { at: Date.now(), data });
    return data;
  }

  /** The objective whose tasks the network should visualize (most recent live one). */
  activeObjective() {
    const live = (this.snapshot?.objectives ?? []).filter((o) =>
      ['planning', 'plan_proposed', 'in_progress', 'open', 'confirmed'].includes(o.status));
    return live[0] ?? null;
  }
}
