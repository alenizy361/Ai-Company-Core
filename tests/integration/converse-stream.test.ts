// Converse streaming over HTTP with the real mock adapter: delta events are
// monotonic stable prefixes that reconstruct done.say; say segments arrive
// before done; client abort mid-generation leaves no assistant message and an
// honestly-labeled aborted model request.
import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeEnv, activateAgents } from '../helpers/fixtures.ts';
import { Router, errorJson } from '../../src/server/router.ts';
import { registerConverseRoutes } from '../../src/server/routes/converse.ts';
import { MockAdapter } from '../../src/adapters/mock.ts';
import type { CompletionRequest, CompletionResult } from '../../src/adapters/types.ts';

interface SseEvent { event: string; data: Record<string, unknown> }

function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split('\n\n')) {
    const ev = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (ev && data) events.push({ event: ev, data: JSON.parse(data) as Record<string, unknown> });
  }
  return events;
}

function startServer(router: Router): Promise<{ base: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const handled = await router.dispatch(req, res);
      if (!handled) errorJson(res, 404, 'NOT_FOUND', 'no route');
    });
    server.listen(0, () => {
      resolve({ base: `http://localhost:${(server.address() as AddressInfo).port}`, close: () => server.close() });
    });
  });
}

test('delta events stream stable prefixes and reconstruct done.say', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const router = new Router();
  registerConverseRoutes(router, env.db, () => new MockAdapter());
  const srv = await startServer(router);
  t.after(srv.close);

  const res = await fetch(`${srv.base}/api/converse`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'what is the current status of the company right now' }),
  });
  const events = parseSse(await res.text());
  const names = events.map((e) => e.event);

  assert.equal(names[0], 'meta');
  assert.ok(names.includes('state'));
  const deltas = events.filter((e) => e.event === 'delta');
  assert.ok(deltas.length >= 2, `expected >=2 delta events, got ${deltas.length}`);
  const done = events.find((e) => e.event === 'done');
  assert.ok(done);
  const reconstructed = deltas.map((d) => String(d.data.text)).join('');
  assert.equal(reconstructed.trim(), String(done!.data.say).trim(), 'deltas reconstruct the final say');
  // say segments exist and every one precedes done.
  const sayIdx = names.indexOf('say');
  assert.ok(sayIdx !== -1 && sayIdx < names.indexOf('done'));
  // route precedes done, deltas precede route (generation before execution).
  assert.ok(names.indexOf('route') < names.indexOf('done'));
  assert.ok(names.indexOf('delta') < names.indexOf('route'));

  // Both messages persisted.
  const conversationId = String(events[0].data.conversationId);
  const rows = env.db.all<{ role: string }>('SELECT role FROM messages WHERE conversation_id = ? ORDER BY created_at', conversationId);
  assert.deepEqual(rows.map((r) => r.role), ['user', 'assistant']);
});

test('client abort mid-generation: no assistant row, aborted model request, user turn preserved', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  process.env.MOCK_TURN_DELAY_MS = '400';
  t.after(() => { delete process.env.MOCK_TURN_DELAY_MS; });
  const router = new Router();
  registerConverseRoutes(router, env.db, () => new MockAdapter());
  const srv = await startServer(router);
  t.after(srv.close);

  const ctrl = new AbortController();
  const reqPromise = fetch(`${srv.base}/api/converse`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'this request will be cancelled mid-stream' }),
    signal: ctrl.signal,
  }).then(async (r) => (r.body ? r.text().catch(() => '') : ''), () => '');
  await new Promise((r) => setTimeout(r, 120));
  ctrl.abort();
  await reqPromise;
  // Give the server a beat to finish its catch path.
  await new Promise((r) => setTimeout(r, 500));

  const conv = env.db.get<{ id: string }>('SELECT id FROM conversations ORDER BY created_at DESC LIMIT 1');
  assert.ok(conv, 'conversation exists');
  const rows = env.db.all<{ role: string }>('SELECT role FROM messages WHERE conversation_id = ?', conv!.id);
  assert.deepEqual(rows.map((r) => r.role), ['user'], 'only the user turn persists');
  const mr = env.db.get<{ parse_status: string; error: string | null }>(
    `SELECT parse_status, error FROM model_requests WHERE purpose = 'converse' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(mr?.parse_status, 'adapter_error');
  assert.equal(mr?.error, 'aborted by client');
});

test('fence-wrapped contract reply is spoken exactly ONCE (the "مرحبا مرحبا" double-say bug)', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const GREETING = 'مرحبا! كيف أساعدك اليوم؟';
  class FencedAdapter extends MockAdapter {
    override async complete(req: CompletionRequest): Promise<CompletionResult> {
      const base = await super.complete(req);
      return { ...base, text: '```json\n' + JSON.stringify({ route: 'reply', say: GREETING }) + '\n```' };
    }
  }
  const router = new Router();
  registerConverseRoutes(router, env.db, () => new FencedAdapter());
  const srv = await startServer(router);
  t.after(srv.close);

  const res = await fetch(`${srv.base}/api/converse`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'مرحبا', modality: 'voice' }),
  });
  const events = parseSse(await res.text());
  const says = events.filter((e) => e.event === 'say').map((e) => String(e.data.text));
  const spoken = says.join(' ');
  const occurrences = spoken.split('كيف أساعدك').length - 1;
  assert.equal(occurrences, 1, `the greeting must be spoken exactly once, got: ${JSON.stringify(says)}`);
  assert.ok(!spoken.includes('```') && !spoken.includes('"route"'), 'no JSON syntax is ever spoken aloud');
  const done = events.find((e) => e.event === 'done');
  assert.equal(String(done?.data.say), GREETING);
});

test('converse confirm_plan route actually confirms the proposed plan and creates tasks', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  // A proposed plan awaiting confirmation (the state the owner was stuck in).
  const now = Date.now();
  const objectiveId = 'obj_convconfirm';
  env.db.run(`INSERT INTO objectives (id, org_id, title, status, created_at, updated_at) VALUES (?, ?, 'voice confirm', 'plan_proposed', ?, ?)`,
    objectiveId, env.cfg.orgId, now, now);
  const planId = 'pln_convconfirm';
  const parsed = {
    reply: 'plan ready', team: ['backend'],
    plan: [{
      step_id: 's1', agent: 'backend', title: 'do the work',
      spec: 'A complete executable specification with enough detail to satisfy the plan validator minimum.',
      depends_on: [], required_inputs: [], expected_artifacts: ['out.md'],
      acceptance_criteria: ['deliverable exists'], verification: [], priority: 3, status: 'queued',
    }],
  };
  env.db.run(`INSERT INTO plans (id, objective_id, version, raw_json, reply, status, created_at) VALUES (?, ?, 1, ?, 'plan ready', 'proposed', ?)`,
    planId, objectiveId, JSON.stringify(parsed), now);

  class ConfirmAdapter extends MockAdapter {
    override async complete(req: CompletionRequest): Promise<CompletionResult> {
      const base = await super.complete(req);
      return { ...base, text: JSON.stringify({ route: 'confirm_plan', plan_id: planId, say: 'Starting the team now.' }) };
    }
  }
  const router = new Router();
  registerConverseRoutes(router, env.db, () => new ConfirmAdapter());
  const srv = await startServer(router);
  t.after(srv.close);

  const res = await fetch(`${srv.base}/api/converse`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'نفّذ الخطة', modality: 'voice' }),
  });
  const events = parseSse(await res.text());
  const route = events.find((e) => e.event === 'route');
  assert.equal(route?.data.route, 'confirm_plan');
  assert.equal(route?.data.planId, planId);
  assert.equal(env.db.get<{ status: string }>('SELECT status FROM plans WHERE id = ?', planId)?.status, 'confirmed',
    'the voice path can now actually start execution');
  assert.equal(env.db.get<{ status: string }>('SELECT status FROM objectives WHERE id = ?', objectiveId)?.status, 'in_progress');
  assert.equal(env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE objective_id = ?', objectiveId)?.n, 1);
});

test('replyLang setting rewrites the SYSTEM contract language rule', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const seenSystem: string[] = [];
  class CaptureAdapter extends MockAdapter {
    override complete(req: CompletionRequest): Promise<CompletionResult> {
      seenSystem.push(req.system);
      return super.complete(req);
    }
  }
  const router = new Router();
  registerConverseRoutes(router, env.db, () => new CaptureAdapter());
  const srv = await startServer(router);
  t.after(srv.close);

  await (await fetch(`${srv.base}/api/converse`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'كيف حال الشركة الآن؟', replyLang: 'en' }),
  })).text();
  // The lock must live in the system contract and REPLACE the mirror rule —
  // a user-turn note contradicting a system-level "Arabic in -> Arabic out"
  // loses to it, which is exactly how the setting used to get ignored.
  assert.match(seenSystem[0], /ALWAYS in English/, 'forced-English rule present in the system contract');
  assert.ok(!/Arabic in -> Arabic out/.test(seenSystem[0]), 'mirror rule replaced, not contradicted');

  await (await fetch(`${srv.base}/api/converse`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'how are things?', replyLang: 'auto' }),
  })).text();
  assert.match(seenSystem[1], /Arabic in -> Arabic out/, 'auto mode keeps the mirror rule');
  assert.ok(!/ALWAYS in English/.test(seenSystem[1]), 'no forced language in auto mode');
});
