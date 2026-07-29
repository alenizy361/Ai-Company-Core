// Voice availability-mode endpoint: token-gated, validated values, persisted
// on the session row (the session record stays honest about how audio is
// being captured).
import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeEnv } from '../helpers/fixtures.ts';
import { Router, errorJson } from '../../src/server/router.ts';
import { registerVoiceRoutes } from '../../src/server/routes/voice.ts';
import { createVoiceSession } from '../../src/voice/session.ts';

test('mode endpoint: auth, validation, persistence', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const router = new Router();
  registerVoiceRoutes(router, env.db);
  const server = createServer(async (req, res) => {
    if (!(await router.dispatch(req, res))) errorJson(res, 404, 'NOT_FOUND', 'no route');
  });
  await new Promise<void>((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  const session = createVoiceSession(env.db, 'web', 900);
  const post = (body: object) => fetch(`${base}/api/voice-session/${session.id}/mode`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  assert.equal((await post({ mode: 'continuous' })).status, 401, 'token required');
  assert.equal((await post({ mode: 'sideways', token: session.token })).status, 400, 'mode validated');
  assert.equal((await post({ mode: 'continuous', token: session.token })).status, 200);
  assert.equal(
    env.db.get<{ availability_mode: string }>('SELECT availability_mode FROM voice_sessions WHERE id = ?', session.id)?.availability_mode,
    'continuous',
  );
});
