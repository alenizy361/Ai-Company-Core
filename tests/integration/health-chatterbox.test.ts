// /api/health must never report "chatterbox" from configuration alone — a
// CHATTERBOX_URL that is set but unreachable has to fall through honestly to
// whatever the client will actually hear (this was exactly the bug: the
// owner set the env var, the service wasn't actually running, and nothing
// told them the voice was still Fish/espeak underneath).
import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeEnv } from '../helpers/fixtures.ts';
import { Router, errorJson, json } from '../../src/server/router.ts';
import { registerHealthRoute } from '../../src/server/routes/health.ts';
import type { SseHub } from '../../src/server/sse.ts';

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

const hubStub = { clientCount: () => 0, lastSeq: () => 0 } as unknown as SseHub;

test('health: CHATTERBOX_URL configured but unreachable never claims the chatterbox voice', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const router = new Router();
  registerHealthRoute(router, env.db, hubStub, env.cfg, () => ({ name: 'mock', reason: 'test' }));
  const srv = await startServer(router);
  t.after(srv.close);

  const prev = process.env.CHATTERBOX_URL;
  process.env.CHATTERBOX_URL = 'http://127.0.0.1:1'; // nothing listens on port 1
  try {
    const health = await (await fetch(`${srv.base}/api/health`)).json() as {
      voiceProviders: { tts: string; chatterboxConfigured?: boolean; chatterboxLive?: boolean };
    };
    assert.notEqual(health.voiceProviders.tts, 'chatterbox', 'unreachable service must not be reported as the active voice');
    assert.equal(health.voiceProviders.chatterboxConfigured, true, 'still honest that it IS configured');
    assert.equal(health.voiceProviders.chatterboxLive, false, 'and honest that it is not actually answering');
  } finally {
    if (prev === undefined) delete process.env.CHATTERBOX_URL; else process.env.CHATTERBOX_URL = prev;
  }
});

test('health: CHATTERBOX_URL pointing at a live service is reported as the active voice', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const fakeChatterbox = createServer((req, res) => {
    if (req.url === '/ready') { json(res, 200, { ready: true }); return; }
    errorJson(res, 404, 'NOT_FOUND', 'no route');
  });
  await new Promise<void>((resolve) => fakeChatterbox.listen(0, resolve));
  t.after(() => fakeChatterbox.close());
  const fakePort = (fakeChatterbox.address() as AddressInfo).port;

  const router = new Router();
  registerHealthRoute(router, env.db, hubStub, env.cfg, () => ({ name: 'mock', reason: 'test' }));
  const srv = await startServer(router);
  t.after(srv.close);

  const prev = process.env.CHATTERBOX_URL;
  process.env.CHATTERBOX_URL = `http://127.0.0.1:${fakePort}`;
  try {
    const health = await (await fetch(`${srv.base}/api/health`)).json() as {
      voiceProviders: { tts: string; chatterboxLive?: boolean };
    };
    assert.equal(health.voiceProviders.tts, 'chatterbox');
    assert.equal(health.voiceProviders.chatterboxLive, true);
  } finally {
    if (prev === undefined) delete process.env.CHATTERBOX_URL; else process.env.CHATTERBOX_URL = prev;
  }
});
