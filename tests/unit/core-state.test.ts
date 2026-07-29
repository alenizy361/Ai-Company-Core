// Composite SIRA Core state derivation: voice wins, transport honesty next,
// worker staleness suppresses execution states, and each execution-phase
// state derives only from real ring events in strict precedence.
import { test } from 'node:test';
import assert from 'node:assert';
import { deriveCoreState, deriveSdkActivity } from '../../web/js/core/core-state.js';

const NOW = 1_000_000;

function base(overrides: Record<string, unknown> = {}): Parameters<typeof deriveCoreState>[0] {
  return {
    voiceState: 'ready',
    connected: true,
    reconnecting: false,
    workerFresh: true,
    runningExecutions: 0,
    pendingApprovals: 0,
    ring: [],
    snapshot: { objectives: [] },
    now: NOW,
    ...overrides,
  } as Parameters<typeof deriveCoreState>[0];
}

test('voice-session states always win', () => {
  for (const s of ['listening', 'transcribing', 'thinking', 'speaking', 'muted', 'failed']) {
    const out = deriveCoreState(base({ voiceState: s, runningExecutions: 3 }));
    assert.equal(out.state, s);
    assert.match(out.source, /^voice:/);
  }
});

test('disconnected stream is sync_lost; reconnecting is reconnecting', () => {
  assert.equal(deriveCoreState(base({ connected: false })).state, 'sync_lost');
  assert.equal(deriveCoreState(base({ connected: false, reconnecting: true })).state, 'reconnecting');
});

test('stale worker suppresses ALL execution states', () => {
  const ring = [
    { seq: 1, type: 'tool.started', at: NOW - 100, payload: {} },
    { seq: 2, type: 'execution.verifying', at: NOW - 50, payload: {} },
  ];
  const out = deriveCoreState(base({ workerFresh: false, runningExecutions: 5, ring }));
  assert.equal(out.state, 'ready');
  assert.equal(out.source, 'worker:stale');
});

test('pending approvals outrank executing', () => {
  const out = deriveCoreState(base({ pendingApprovals: 2, runningExecutions: 3 }));
  assert.equal(out.state, 'waiting_for_approval');
});

test('using_tool only while a tool.started has no terminal event, with seq attribution', () => {
  const openTool = [{ seq: 10, type: 'tool.started', at: NOW - 200, payload: {} }];
  const out = deriveCoreState(base({ ring: openTool, runningExecutions: 1 }));
  assert.equal(out.state, 'using_tool');
  assert.equal(out.seq, 10);
  const closedTool = [...openTool, { seq: 11, type: 'tool.succeeded', at: NOW - 100, payload: {} }];
  assert.equal(deriveCoreState(base({ ring: closedTool, runningExecutions: 1 })).state, 'executing');
});

test('verifying outranks using_tool; receiving_handoff is a bounded live pulse', () => {
  const ring = [
    { seq: 20, type: 'tool.started', at: NOW - 300, payload: {} },
    { seq: 21, type: 'execution.verifying', at: NOW - 200, payload: {} },
  ];
  assert.equal(deriveCoreState(base({ ring, runningExecutions: 1 })).state, 'verifying');

  const fresh = [{ seq: 30, type: 'handoff.created', at: NOW - 500, payload: {} },
    { seq: 29, type: 'tool.succeeded', at: NOW - 600, payload: {} }];
  assert.equal(deriveCoreState(base({ ring: fresh, runningExecutions: 1 })).state, 'receiving_handoff');
  const staleHandoff = [{ seq: 30, type: 'handoff.created', at: NOW - 5000, payload: {} }];
  assert.equal(deriveCoreState(base({ ring: staleHandoff, runningExecutions: 1 })).state, 'executing');
});

test('connecting_agents between plan.confirmed and the first claim', () => {
  const ring = [{ seq: 40, type: 'plan.confirmed', at: NOW - 1000, payload: {} }];
  assert.equal(deriveCoreState(base({ ring })).state, 'connecting_agents');
  const claimed = [...ring, { seq: 41, type: 'task.status', at: NOW - 500, payload: { source: 'worker_claim' } }];
  assert.equal(deriveCoreState(base({ ring: claimed, runningExecutions: 1 })).state, 'executing');
});

test('creating_plan only while planning is genuinely in flight', () => {
  const ring = [{ seq: 50, type: 'planning.started', at: NOW - 1000, payload: {} }];
  const snapshot = { objectives: [{ status: 'planning' }] };
  assert.equal(deriveCoreState(base({ ring, snapshot })).state, 'creating_plan');
  const done = [...ring, { seq: 51, type: 'plan.proposed', at: NOW - 200, payload: {} }];
  assert.equal(deriveCoreState(base({ ring: done, snapshot })).state, 'ready');
});

test('recent unretryable failure surfaces briefly, then yields', () => {
  const ring = [{ seq: 60, type: 'execution.finished', at: NOW - 2000, payload: { status: 'failed', willRetry: false } }];
  assert.equal(deriveCoreState(base({ ring })).state, 'failed');
  const old = [{ seq: 60, type: 'execution.finished', at: NOW - 60000, payload: { status: 'failed', willRetry: false } }];
  assert.equal(deriveCoreState(base({ ring: old })).state, 'ready');
});

// ---- Agent-SDK activity (sira.* events; NOT gated on worker freshness) ----

test('SDK subagent activity renders executing even with a stale worker (it runs in the API process)', () => {
  const ring = [
    { seq: 10, type: 'sira.agent.started', agentKey: 'product', at: NOW - 5000 },
  ];
  const out = deriveCoreState(base({ ring, workerFresh: false }));
  assert.equal(out.state, 'executing');
  assert.equal(out.seq, 10);
});

test('SDK tool use is the finer state and clears at sira.execution.completed', () => {
  const ring = [
    { seq: 10, type: 'sira.tool.started', agentKey: 'sira', at: NOW - 1000 },
  ];
  assert.equal(deriveCoreState(base({ ring })).state, 'using_tool');
  const done = [...ring, { seq: 11, type: 'sira.execution.completed', at: NOW - 500 }];
  assert.equal(deriveCoreState(base({ ring: done })).state, 'ready');
});

test('deriveSdkActivity: lifecycle replay — started, tool, completed, turn-end clear, staleness', () => {
  const active = deriveSdkActivity([
    { seq: 1, type: 'sira.agent.started', agentKey: 'product', at: NOW - 900 },
    { seq: 2, type: 'sira.agent.started', agentKey: 'ux', at: NOW - 800 },
    { seq: 3, type: 'sira.tool.started', agentKey: 'ux', at: NOW - 700 },
    { seq: 4, type: 'sira.agent.completed', agentKey: 'product', at: NOW - 600 },
  ], NOW);
  assert.equal(active.has('product'), false, 'completed agent leaves the board');
  assert.equal(active.get('ux')?.status, 'using_tool');

  const cleared = deriveSdkActivity([
    { seq: 1, type: 'sira.agent.started', agentKey: 'product', at: NOW - 900 },
    { seq: 2, type: 'sira.execution.completed', at: NOW - 100 },
  ], NOW);
  assert.equal(cleared.size, 0, 'turn end clears all activity');

  const stale = deriveSdkActivity([
    { seq: 1, type: 'sira.agent.started', agentKey: 'product', at: NOW - 700000 },
  ], NOW);
  assert.equal(stale.size, 0, 'a server killed mid-turn cannot pin activity forever');
});
