// LIVE Agent SDK acceptance (real Claude auth required — run via `npm run
// test:sdk`; skips cleanly when no auth exists). Exercises the full product
// path over HTTP: POST /api/converse -> persistent parent SDK session ->
// real tool use -> streamed deltas -> speakable say events -> conversational
// done.say -> same-session follow-up with retained context.
import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv } from '../helpers/fixtures.ts';
import { Router, errorJson } from '../../src/server/router.ts';
import { registerConverseRoutes } from '../../src/server/routes/converse.ts';
import { MockAdapter } from '../../src/adapters/mock.ts';
import { SiraManager } from '../../src/sira/session.ts';
import { cliAvailable } from '../../src/adapters/select.ts';
import { loadPaths } from '../../src/shared/config.ts';

const AUTH_OK = Boolean(process.env.ANTHROPIC_API_KEY) || cliAvailable().ok;

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

test('LIVE: SDK-backed converse — real tool, streamed reply, same-session follow-up', { timeout: 300000 }, async (t) => {
  if (!AUTH_OK) {
    t.skip('no Claude auth (ANTHROPIC_API_KEY or authenticated CLI) — live SDK test skipped');
    return;
  }
  const env = makeEnv();
  t.after(() => env.cleanup());
  const paths = loadPaths();
  const sira = new SiraManager(env.db, env.cfg, paths);
  t.after(() => sira.closeAll());

  const router = new Router();
  registerConverseRoutes(router, env.db, () => new MockAdapter(), sira);
  const server = createServer(async (req, res) => {
    const handled = await router.dispatch(req, res);
    if (!handled) errorJson(res, 404, 'NOT_FOUND', 'no route');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  t.after(() => server.close());

  // Turn 1: force a REAL tool call and a conversational final response.
  const res1 = await fetch(`${base}/api/converse`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Create a file named slice.txt containing exactly "live slice ok" in your working directory using your tools, then tell me conversationally what you did.', modality: 'text' }),
  });
  const events1 = parseSse(await res1.text());
  const conversationId = String(events1.find((e) => e.event === 'meta')?.data.conversationId);
  const done1 = events1.find((e) => e.event === 'done');
  const say1 = String(done1?.data.say ?? '');

  assert.ok(events1.some((e) => e.event === 'exec' && /sira\.tool\.started/.test(String(e.data.type))), 'real tool activity streamed');
  const workFile = join(paths.workspaceDir, 'sira', conversationId, 'slice.txt');
  assert.ok(existsSync(workFile), 'the tool actually wrote the file on disk');
  assert.equal(readFileSync(workFile, 'utf8').trim(), 'live slice ok');
  assert.ok(say1.length > 20, 'final response is conversational text');
  assert.ok(!/^(done|task completed|completed)[.!]?$/i.test(say1.trim()), 'a completed task is never the final response');
  assert.ok(events1.filter((e) => e.event === 'delta').length >= 1, 'parent output streamed');
  const spoken1 = events1.filter((e) => e.event === 'say').map((e) => String(e.data.text)).join(' ');
  assert.ok(!spoken1.includes('```'), 'no code fences reach TTS');
  // The route event carries the real SDK session id (distinct namespace).
  const route1 = events1.find((e) => e.event === 'route');
  assert.equal(route1?.data.engine, 'agent-sdk');
  assert.ok(route1?.data.sdkSessionId, 'SDK session id captured');
  assert.ok(env.db.get('SELECT sdk_session_id FROM sdk_sessions WHERE conversation_id = ?', conversationId), 'session persisted');

  // Turn 2: SAME conversation — context must be retained by the parent session.
  const res2 = await fetch(`${base}/api/converse`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'In one sentence: what file did you just create and what did it contain?', modality: 'text', conversationId }),
  });
  const events2 = parseSse(await res2.text());
  const say2 = String(events2.find((e) => e.event === 'done')?.data.say ?? '');
  assert.match(say2, /slice\.txt|live slice ok/i, 'same parent session retained the prior turn context');

  // Both turns persisted as ordinary conversation messages.
  const rows = env.db.all<{ role: string }>('SELECT role FROM messages WHERE conversation_id = ? ORDER BY created_at', conversationId);
  assert.deepEqual(rows.map((r) => r.role), ['user', 'assistant', 'user', 'assistant']);
});
