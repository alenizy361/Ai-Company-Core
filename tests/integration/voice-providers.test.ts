// Fixture tests for the key-gated external voice provider relays: honest 503
// labeling without keys, exact upstream request shapes with keys (stubbed
// fetch — no network), token-gated access, and LiveKit JWT integrity.
import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { makeEnv } from '../helpers/fixtures.ts';
import { Router, errorJson } from '../../src/server/router.ts';
import { registerVoiceProviderRoutes, mintLivekitToken, espeakBin } from '../../src/server/routes/voice-providers.ts';
import { createVoiceSession } from '../../src/voice/session.ts';

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

test('voice providers: session-gated, honest 503s, correct upstream shapes', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());

  const captured: { url: string; init?: RequestInit }[] = [];
  const stubFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    captured.push({ url, init });
    if (url.includes('deepgram')) {
      return new Response(JSON.stringify({
        results: { channels: [{ alternatives: [{ transcript: 'مرحبا رابت', confidence: 0.97 }] }] },
      }), { status: 200 });
    }
    return new Response(new Blob([Buffer.from('FAKE_MP3_BYTES')]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };

  // Unconfigured instance (and no local TTS binary): every provider reports
  // the exact missing env var.
  const bareRouter = new Router();
  registerVoiceProviderRoutes(bareRouter, env.db, { env: {}, fetchImpl: stubFetch, localTts: false });
  const bare = await startServer(bareRouter);
  t.after(bare.close);
  const session = createVoiceSession(env.db, 'test', 900);
  const auth = `session=${session.id}&token=${session.token}`;

  for (const [path, envVar] of [
    ['stt', 'DEEPGRAM_API_KEY'], ['tts', 'FISH_AUDIO_API_KEY'],
    ['livekit-token', 'LIVEKIT_URL'], ['wake-key', 'PICOVOICE_ACCESS_KEY'],
  ]) {
    const res = await fetch(`${bare.base}/api/voice/${path}?${auth}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"x"}',
    });
    assert.equal(res.status, 503, path);
    const body = await res.json() as { error: { message: string } };
    assert.match(body.error.message, new RegExp(envVar), `${path} names ${envVar}`);
  }

  // No session token -> 401 even with keys configured.
  const keyedRouter = new Router();
  registerVoiceProviderRoutes(keyedRouter, env.db, {
    env: {
      DEEPGRAM_API_KEY: 'dg-key', FISH_AUDIO_API_KEY: 'fish-key',
      LIVEKIT_URL: 'wss://lk.example', LIVEKIT_API_KEY: 'lk-key', LIVEKIT_API_SECRET: 'lk-secret',
      PICOVOICE_ACCESS_KEY: 'pico-key',
    },
    fetchImpl: stubFetch,
  });
  const keyed = await startServer(keyedRouter);
  t.after(keyed.close);
  assert.equal((await fetch(`${keyed.base}/api/voice/wake-key`, { method: 'POST' })).status, 401);

  // Deepgram relay: auth header + language + raw audio passthrough + parsed transcript.
  const audio = Buffer.alloc(4000, 7);
  const stt = await fetch(`${keyed.base}/api/voice/stt?${auth}&lang=ar`, {
    method: 'POST', headers: { 'content-type': 'audio/webm' }, body: audio,
  });
  assert.equal(stt.status, 200);
  const sttBody = await stt.json() as { provider: string; text: string };
  assert.equal(sttBody.provider, 'deepgram');
  assert.equal(sttBody.text, 'مرحبا رابت');
  const dgCall = captured.find((c) => c.url.includes('deepgram'));
  assert.ok(dgCall && dgCall.url.includes('language=ar'));
  assert.equal((dgCall!.init!.headers as Record<string, string>).Authorization, 'Token dg-key');
  assert.equal((dgCall!.init!.body as Buffer).length, 4000);

  // Fish Audio relay: bearer key, audio streamed back with upstream content type.
  const tts = await fetch(`${keyed.base}/api/voice/tts?${auth}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'أهلا' }),
  });
  assert.equal(tts.status, 200);
  assert.equal(tts.headers.get('content-type'), 'audio/mpeg');
  assert.equal(Buffer.from(await tts.arrayBuffer()).toString(), 'FAKE_MP3_BYTES');
  const fishCall = captured.find((c) => c.url.includes('fish.audio'));
  assert.equal((fishCall!.init!.headers as Record<string, string>).Authorization, 'Bearer fish-key');

  // LiveKit token: valid HS256 JWT with room grant, verifiable signature.
  const lk = await fetch(`${keyed.base}/api/voice/livekit-token?${auth}`, { method: 'POST' });
  assert.equal(lk.status, 200);
  const lkBody = await lk.json() as { url: string; token: string };
  assert.equal(lkBody.url, 'wss://lk.example');
  const [header, payload, signature] = lkBody.token.split('.');
  const expected = createHmac('sha256', 'lk-secret').update(`${header}.${payload}`).digest('base64url');
  assert.equal(signature, expected);
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { iss: string; video: { room: string } };
  assert.equal(claims.iss, 'lk-key');
  assert.equal(claims.video.room, 'sira-voice');

  // Wake key delivered only to an authenticated session.
  const wake = await fetch(`${keyed.base}/api/voice/wake-key?${auth}`, { method: 'POST' });
  assert.equal((await wake.json() as { accessKey: string }).accessKey, 'pico-key');
});

test('local espeak TTS: zero-key Arabic synthesis through the same relay', async (t) => {
  if (!espeakBin()) return t.skip('espeak-ng not installed on this machine');
  const env = makeEnv();
  t.after(() => env.cleanup());
  const router = new Router();
  registerVoiceProviderRoutes(router, env.db, { env: {} }); // no keys — local voice auto-detected
  const srv = await startServer(router);
  t.after(srv.close);
  const session = createVoiceSession(env.db, 'test', 900);

  const res = await fetch(`${srv.base}/api/voice/tts?session=${session.id}&token=${session.token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'مرحباً، أنا سيرا.' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF', 'real WAV audio produced');
  assert.ok(bytes.length > 1000, `audio has substance (${bytes.length} bytes)`);
});

test('mintLivekitToken is deterministic and time-bounded', () => {
  const token = mintLivekitToken('k', 's', 'me', 'room', 60, 1000000);
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { exp: number; nbf: number };
  assert.equal(payload.exp, 1000060);
  assert.equal(payload.nbf, 999990);
});
