// SiraSession/SiraManager lifecycle fixes: idle eviction, the session cap,
// the delegationEnabled TOCTOU race across overlapping turns, and close()
// actually terminating the underlying CLI subprocess.
//
// SiraSession's real constructor spawns a live Agent SDK Query (a real CLI
// subprocess) — impractical to drive for every case here. TypeScript's
// `private` is compile-time only, so a SiraSession built via
// Object.create(SiraSession.prototype) plus direct field assignment is a
// real instance whose actual send()/close()/interrupt() method bodies run
// against controlled collaborators (db/q/input stubs) — this exercises the
// REAL logic under test, not a reimplementation of it. Cases that need an
// actual freshly-CONSTRUCTED replacement session (cap eviction end-to-end,
// heal/recreate preserving delegationEnabled) are covered instead in
// tests/live/sira-sdk.test.ts against a real SiraSession, gated on real
// Claude auth like every other live test.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeEnv } from '../helpers/fixtures.ts';
import { SiraSession, SiraManager } from '../../src/sira/session.ts';

interface FakeOverrides {
  db?: { run: (...args: unknown[]) => unknown };
  q?: { close: () => void; interrupt: () => Promise<void> };
  input?: { push: (m: unknown) => void; end: () => void };
  activeTurn?: unknown;
  failed?: string | null;
  lastMessageAtMs?: number;
  delegationEnabled?: boolean;
  conversationId?: string;
}

function fakeSession(overrides: FakeOverrides = {}): SiraSession {
  const session = Object.create(SiraSession.prototype) as SiraSession;
  const s = session as unknown as Record<string, unknown>;
  s.conversationId = overrides.conversationId ?? 'cnv_fake';
  s.db = overrides.db ?? { run: () => {} };
  s.q = overrides.q ?? { close: () => {}, interrupt: async () => {} };
  s.input = overrides.input ?? { push: () => {}, end: () => {} };
  s.activeTurn = overrides.activeTurn ?? null;
  s.turnChain = Promise.resolve();
  s.pendingTurns = 0;
  s.failed = overrides.failed ?? null;
  s.lastMessageAtMs = overrides.lastMessageAtMs ?? Date.now();
  session.delegationEnabled = overrides.delegationEnabled ?? true;
  return session;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('SiraSession.close(): calls q.close() so the underlying CLI subprocess is actually terminated', () => {
  let qClosed = false;
  let inputEnded = false;
  let dbUpdated = false;
  const session = fakeSession({
    q: { close: () => { qClosed = true; }, interrupt: async () => {} },
    input: { push: () => {}, end: () => { inputEnded = true; } },
    db: { run: () => { dbUpdated = true; } },
  });
  session.close();
  assert.ok(qClosed, 'q.close() must be invoked — interrupt() already did this correctly, close() did not');
  assert.ok(inputEnded, 'input.end() is still called too');
  assert.ok(dbUpdated, 'the sdk_sessions bookkeeping row is still updated');
});

test('SiraSession.close(): a throwing q.close() never prevents the rest of close() from completing', () => {
  let dbUpdated = false;
  const session = fakeSession({
    q: { close: () => { throw new Error('already dead'); }, interrupt: async () => {} },
    db: { run: () => { dbUpdated = true; } },
  });
  assert.doesNotThrow(() => session.close());
  assert.ok(dbUpdated, 'db bookkeeping still runs after q.close() throws — matches the file\'s defensive try/catch style');
});

test('SiraSession.send(): delegationEnabled is set inside the queued turnChain callback, not synchronously at the call site', async () => {
  const pushed: unknown[] = [];
  const session = fakeSession({ delegationEnabled: true });
  (session as unknown as { input: { push: (m: unknown) => void; end: () => void } }).input = {
    push: (m: unknown) => {
      pushed.push(m);
      (session as unknown as { activeTurn: unknown }).activeTurn = null;
    },
    end: () => {},
  };

  session.send('hello', false);
  assert.equal(session.delegationEnabled, true, 'the queued callback has not run yet — call-site mutation would be the old TOCTOU bug');

  await waitUntil(() => pushed.length === 1);
  assert.equal(session.delegationEnabled, false, 'once the queued callback actually runs, it applies the flag it was given');
});

test('SiraSession.send(): overlapping sends never let a later call overwrite an earlier turn\'s delegationEnabled', async () => {
  const pushed: { text: string; delegationEnabledAtPush: boolean }[] = [];
  const session = fakeSession({ delegationEnabled: true });
  (session as unknown as { input: { push: (m: unknown) => void; end: () => void } }).input = {
    push: (m: unknown) => {
      const text = (m as { message: { content: string } }).message.content;
      pushed.push({ text, delegationEnabledAtPush: session.delegationEnabled });
      // Simulate the turn completing instantly so the next queued send can
      // proceed without waiting on the real 15-minute wedge watchdog.
      (session as unknown as { activeTurn: unknown }).activeTurn = null;
    },
    end: () => {},
  };

  // Both calls are made back-to-back, BEFORE either queued turnChain
  // callback has run — this is exactly the overlap that used to let
  // request B's synchronous write land ahead of request A's turn.
  session.send('turn A', true);
  session.send('turn B', false);

  await waitUntil(() => pushed.length === 2);
  assert.deepEqual(pushed.map((p) => p.text), ['turn A', 'turn B'], 'turns are still strictly serialized');
  assert.equal(pushed[0].delegationEnabledAtPush, true, "turn A's own canUseTool-equivalent check must see turn A's own flag, not turn B's");
  assert.equal(pushed[1].delegationEnabledAtPush, false);
});

test('SiraSession.send(): the pending-turn queue is bounded — an overflow send is rejected immediately, not queued forever', async () => {
  const session = fakeSession({ delegationEnabled: true });
  (session as unknown as { input: { push: (m: unknown) => void; end: () => void } }).input = {
    push: () => {
      // Complete instantly so no queued turn is left hanging on the real
      // 15-minute wedge watchdog once the test starts awaiting anything.
      (session as unknown as { activeTurn: unknown }).activeTurn = null;
    },
    end: () => {},
  };

  const MAX = 20; // must match SiraSession.MAX_PENDING_TURNS
  const streams = [];
  // Filled in one synchronous burst — pendingTurns increments happen
  // inline in send(), so by the time this loop ends it is guaranteed to be
  // exactly MAX, regardless of how fast queued turns later complete.
  for (let i = 0; i < MAX + 1; i++) streams.push(session.send(`turn ${i}`));

  // The (MAX+1)th call must be rejected synchronously with an error turn —
  // it must never be silently appended to an unbounded queue.
  const overflow = streams[MAX];
  const first = await overflow.next();
  assert.equal(first.value?.kind, 'error');
  assert.match((first.value as { message: string }).message, /too many turns already queued/);
  const second = await overflow.next();
  assert.equal(second.done, true, 'the rejected turn stream finishes immediately, nothing more to yield');

  // Let the MAX real (accepted) turns fully drain before returning — each
  // resolves via the file's 100ms watchdog-poll granularity, so this takes
  // a couple of seconds. Leaving them running past this test's return would
  // corrupt node:test's cancellation tracking for later tests in this file.
  await waitUntil(() => (session as unknown as { pendingTurns: number }).pendingTurns === 0, 6000);
  await new Promise((resolve) => setTimeout(resolve, 150));
});

test('SiraSession.send(): omitting delegationEnabled leaves the session\'s current value untouched (internal callers with no owner toggle)', async () => {
  const pushed: unknown[] = [];
  const session = fakeSession({ delegationEnabled: false });
  (session as unknown as { input: { push: (m: unknown) => void; end: () => void } }).input = {
    push: (m: unknown) => {
      pushed.push(m);
      (session as unknown as { activeTurn: unknown }).activeTurn = null;
    },
    end: () => {},
  };

  session.send('internal completion turn');
  await waitUntil(() => pushed.length === 1);
  assert.equal(session.delegationEnabled, false, 'no delegate arg means the session\'s existing setting is preserved');
});

test('SiraManager.sweepIdle(): evicts a turn-inactive session past the idle threshold; leaves an active-turn session alone', () => {
  const env = makeEnv();
  try {
    const manager = new SiraManager(env.db, env.cfg, env.paths);
    const sessions = (manager as unknown as { sessions: Map<string, SiraSession> }).sessions;
    const now = Date.now();
    let idleClosed = false;
    let activeClosed = false;
    sessions.set('cnv_idle', fakeSession({
      conversationId: 'cnv_idle', lastMessageAtMs: now - 10_000, activeTurn: null,
      q: { close: () => { idleClosed = true; }, interrupt: async () => {} },
    }));
    sessions.set('cnv_active', fakeSession({
      conversationId: 'cnv_active', lastMessageAtMs: now - 10_000, activeTurn: {},
      q: { close: () => { activeClosed = true; }, interrupt: async () => {} },
    }));

    manager.sweepIdle(5_000);

    assert.equal(manager.get('cnv_idle'), undefined, 'a turn-inactive session past the idle threshold is evicted');
    assert.ok(idleClosed, 'close() (and therefore q.close()) was invoked on the evicted session');
    assert.ok(manager.get('cnv_active'), 'a session with an active turn is never evicted, no matter how idle lastMessageAt looks');
    assert.equal(activeClosed, false);
  } finally {
    env.cleanup();
  }
});

test('SiraManager.sweepIdle(): a turn-inactive session under the idle threshold is left alone', () => {
  const env = makeEnv();
  try {
    const manager = new SiraManager(env.db, env.cfg, env.paths);
    const sessions = (manager as unknown as { sessions: Map<string, SiraSession> }).sessions;
    sessions.set('cnv_fresh', fakeSession({ conversationId: 'cnv_fresh', lastMessageAtMs: Date.now(), activeTurn: null }));

    manager.sweepIdle(3_600_000);

    assert.ok(manager.get('cnv_fresh'), 'a recently active session is never evicted');
  } finally {
    env.cleanup();
  }
});

test('SiraManager cap eviction: evicts exactly the single most-idle turn-inactive session among several candidates', () => {
  const env = makeEnv();
  try {
    const manager = new SiraManager(env.db, env.cfg, env.paths);
    const sessions = (manager as unknown as { sessions: Map<string, SiraSession> }).sessions;
    const now = Date.now();
    const closedIds: string[] = [];
    const make = (id: string, lastMessageAtMs: number): SiraSession => fakeSession({
      conversationId: id, lastMessageAtMs, activeTurn: null,
      q: { close: () => { closedIds.push(id); }, interrupt: async () => {} },
    });
    sessions.set('cnv_newest', make('cnv_newest', now - 1_000));
    sessions.set('cnv_oldest', make('cnv_oldest', now - 50_000));
    sessions.set('cnv_middle', make('cnv_middle', now - 20_000));

    (manager as unknown as { evictMostIdle: () => void }).evictMostIdle();

    assert.deepEqual(closedIds, ['cnv_oldest'], 'exactly the single most-idle entry is evicted, not the others');
    assert.equal(manager.get('cnv_oldest'), undefined);
    assert.ok(manager.get('cnv_newest'));
    assert.ok(manager.get('cnv_middle'));
    assert.equal(sessions.size, 2);
  } finally {
    env.cleanup();
  }
});

test('SiraManager cap eviction: never evicts a session with an active turn, even if it is the only candidate', () => {
  const env = makeEnv();
  try {
    const manager = new SiraManager(env.db, env.cfg, env.paths);
    const sessions = (manager as unknown as { sessions: Map<string, SiraSession> }).sessions;
    let closed = false;
    sessions.set('cnv_busy', fakeSession({
      conversationId: 'cnv_busy', lastMessageAtMs: Date.now() - 999_999, activeTurn: {},
      q: { close: () => { closed = true; }, interrupt: async () => {} },
    }));

    (manager as unknown as { evictMostIdle: () => void }).evictMostIdle();

    assert.equal(closed, false, 'a mid-turn session is never evicted — never reject a legitimate new conversation by killing live work either');
    assert.ok(manager.get('cnv_busy'));
    assert.equal(sessions.size, 1);
  } finally {
    env.cleanup();
  }
});
