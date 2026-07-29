// Converse streaming over HTTP with the real mock adapter: delta events are
// monotonic stable prefixes that reconstruct done.say; say segments arrive
// before done; client abort mid-generation leaves no assistant message and an
// honestly-labeled aborted model request.
import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeEnv } from '../helpers/fixtures.ts';
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

test('replyLang setting injects the forced-language instruction', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const seen: string[] = [];
  class CaptureAdapter extends MockAdapter {
    override complete(req: CompletionRequest): Promise<CompletionResult> {
      seen.push(req.messages[req.messages.length - 1].content);
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
  assert.match(seen[0], /always write "say" in English/, 'forced-English instruction present');

  await (await fetch(`${srv.base}/api/converse`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'how are things?', replyLang: 'auto' }),
  })).text();
  assert.ok(!/OWNER SETTING/.test(seen[1]), 'auto mode mirrors the speaker (no forced instruction)');
});
