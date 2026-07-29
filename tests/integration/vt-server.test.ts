// Voice/interface truth tests against a real API server process (mock model):
// session tokens, source-validated transitions over HTTP, converse persistence,
// honest health + degradation labels.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { REPO_ROOT } from '../../src/shared/config.ts';

const PORT = 4890;
const BASE = `http://localhost:${PORT}`;
let server: ChildProcess;
let dir: string;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sira-vt-'));
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(REPO_ROOT, 'src', 'server', 'index.ts')], {
    env: { ...process.env, SIRA_VAR: dir, PORT: String(PORT), ADAPTER: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
  }
  throw new Error('server did not start');
});

after(() => {
  server?.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
});

test('health reports honest degradation: mock adapter labeled, worker offline, provider fallbacks', async () => {
  const health = await (await fetch(`${BASE}/api/health`)).json() as any;
  assert.equal(health.adapter.name, 'mock');
  assert.match(health.adapter.reason, /ADAPTER=mock/);
  assert.equal(health.worker.online, false);
  assert.equal(health.voiceProviders.stt, 'webspeech');
  assert.equal(health.voiceProviders.wake, 'none');
});

test('voice session over HTTP: token auth + fabricated states rejected with 422', async () => {
  const session = await (await fetch(`${BASE}/api/voice-session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientKind: 'test' }),
  })).json() as any;
  assert.ok(session.id && session.token);

  const bad = await fetch(`${BASE}/api/voice-session/${session.id}/transition`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'ready', source: 'client_boot', token: 'wrong' }),
  });
  assert.equal(bad.status, 401);

  const ok = await fetch(`${BASE}/api/voice-session/${session.id}/transition`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'ready', source: 'client_boot', token: session.token }),
  });
  assert.equal(ok.status, 200);

  const fabricated = await fetch(`${BASE}/api/voice-session/${session.id}/transition`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'speaking', source: 'client_boot', token: session.token }),
  });
  assert.equal(fabricated.status, 422);
  const body = await fabricated.json() as any;
  assert.match(body.reason, /may not claim/);
});

test('converse: streams honest mock reply, persists both messages, keeps conversation', async () => {
  const res = await fetch(`${BASE}/api/converse`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'what is running right now?', modality: 'text' }),
  });
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.match(raw, /event: say/);
  assert.match(raw, /MOCK MODE/);
  assert.match(raw, /event: done/);
  const meta = JSON.parse(/event: meta\ndata: (.*)\n/.exec(raw)?.[1] ?? '{}');

  const messages = await (await fetch(`${BASE}/api/conversations/${meta.conversationId}`)).json() as any;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].role, 'assistant');
  assert.match(messages[1].content, /MOCK MODE/);
});

test('interface truth over HTTP: /api/state shows nothing running with no worker', async () => {
  const state = await (await fetch(`${BASE}/api/state`)).json() as any;
  assert.equal(state.workerFresh, false);
  assert.equal(state.runningExecutions.length, 0);
  for (const agent of state.agents) {
    assert.notEqual(agent.status, 'running');
  }
});
