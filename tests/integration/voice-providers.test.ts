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
  assert.equal((fishCall!.init!.headers as Record<string, string>).model, 's2.1-pro-free', 'free tier is the default model');

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

test('keyed Fish Audio failing upstream (e.g. no credit) falls back to the local voice', async (t) => {
  if (!espeakBin()) return t.skip('espeak-ng not installed on this machine');
  const env = makeEnv();
  t.after(() => env.cleanup());
  const router = new Router();
  registerVoiceProviderRoutes(router, env.db, {
    env: { FISH_AUDIO_API_KEY: 'fish-key-without-credit' },
    fetchImpl: async () => new Response(JSON.stringify({ message: 'Insufficient API credit', status: 402 }), { status: 402 }),
  });
  const srv = await startServer(router);
  t.after(srv.close);
  const session = createVoiceSession(env.db, 'test', 900);

  const res = await fetch(`${srv.base}/api/voice/tts?session=${session.id}&token=${session.token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'fallback keeps the voice alive.' }),
  });
  assert.equal(res.status, 200, 'no silence: local voice serves the reply');
  assert.equal(res.headers.get('x-sira-tts-provider'), 'espeak-fallback');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
});

test('Chatterbox (local persistent TTS) is tried first when CHATTERBOX_URL is configured', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const captured: string[] = [];
  const router = new Router();
  registerVoiceProviderRoutes(router, env.db, {
    env: { CHATTERBOX_URL: 'http://cb.local:8765', FISH_AUDIO_API_KEY: 'fish-key' },
    fetchImpl: async (url) => {
      captured.push(String(url));
      if (String(url).includes('cb.local')) {
        return new Response(Buffer.from('RIFF....WAVEfake'), { status: 200, headers: { 'content-type': 'audio/wav' } });
      }
      return new Response(new Blob([Buffer.from('FAKE_MP3')]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    },
  });
  const srv = await startServer(router);
  t.after(srv.close);
  const session = createVoiceSession(env.db, 'test', 900);

  const res = await fetch(`${srv.base}/api/voice/tts?session=${session.id}&token=${session.token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-sira-tts-provider'), 'chatterbox');
  assert.ok(captured[0].includes('cb.local'), 'chatterbox is tried before fish audio');
  assert.ok(!captured.some((u) => u.includes('fish.audio')), 'fish audio is never called when chatterbox answers');
});

test('sticky provider: one reply never flips voices mid-sentence — a mid-turn failure switches once and stays switched', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  let cbCalls = 0;
  const router = new Router();
  registerVoiceProviderRoutes(router, env.db, {
    env: { CHATTERBOX_URL: 'http://cb.local:8765', FISH_AUDIO_API_KEY: 'fish-key' },
    fetchImpl: async (url) => {
      if (String(url).includes('cb.local')) {
        cbCalls += 1;
        // First sentence: Chatterbox is up. From then on it is unreachable —
        // a real "service died mid-reply" scenario.
        if (cbCalls === 1) return new Response(Buffer.from('RIFF....WAVEfake'), { status: 200, headers: { 'content-type': 'audio/wav' } });
        throw new Error('ECONNREFUSED');
      }
      return new Response(new Blob([Buffer.from('FAKE_MP3')]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    },
  });
  const srv = await startServer(router);
  t.after(srv.close);
  const session = createVoiceSession(env.db, 'test', 900);
  const auth = `session=${session.id}&token=${session.token}`;

  const say = (text: string) => fetch(`${srv.base}/api/voice/tts?${auth}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  });

  const first = await say('sentence one.');
  assert.equal(first.headers.get('x-sira-tts-provider'), 'chatterbox');

  const second = await say('sentence two, same reply.');
  assert.equal(second.headers.get('x-sira-tts-provider'), 'fish-audio', 'switches once when chatterbox dies mid-reply');

  const third = await say('sentence three, same reply.');
  assert.equal(third.headers.get('x-sira-tts-provider'), 'fish-audio', 'stays on fish-audio — never re-probes chatterbox within the same reply');
});

test('Fish Audio: an unbounded hang no longer silences SIRA — it is bounded and falls back', async (t) => {
  if (!espeakBin()) return t.skip('espeak-ng not installed on this machine');
  const env = makeEnv();
  t.after(() => env.cleanup());
  const router = new Router();
  registerVoiceProviderRoutes(router, env.db, {
    env: { FISH_AUDIO_API_KEY: 'fish-key' },
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      // Simulates the real bug: an upstream connection that never resolves
      // and never rejects on its own — only the request's own AbortSignal
      // can end it. Before this fix there was no signal at all, so this
      // would hang the TTS relay (and the client's queue) forever.
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  const srv = await startServer(router);
  t.after(srv.close);
  const session = createVoiceSession(env.db, 'test', 900);

  const startedAt = Date.now();
  const res = await fetch(`${srv.base}/api/voice/tts?session=${session.id}&token=${session.token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'never answers' }),
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(res.status, 200, 'a permanently hung upstream must still produce a reply, not silence');
  assert.equal(res.headers.get('x-sira-tts-provider'), 'espeak-fallback');
  assert.ok(elapsedMs < 20_000, `must not wait anywhere near the old unbounded hang (took ${elapsedMs}ms)`);
});

test('Fish Audio: a single transient failure retries once and still answers with the real voice', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  let calls = 0;
  const router = new Router();
  registerVoiceProviderRoutes(router, env.db, {
    env: { FISH_AUDIO_API_KEY: 'fish-key' },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient network blip');
      return new Response(new Blob([Buffer.from('FAKE_MP3')]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    },
  });
  const srv = await startServer(router);
  t.after(srv.close);
  const session = createVoiceSession(env.db, 'test', 900);

  const res = await fetch(`${srv.base}/api/voice/tts?session=${session.id}&token=${session.token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'one blip then fine' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-sira-tts-provider'), 'fish-audio', 'a transient blip must not permanently downgrade the voice');
  assert.equal(calls, 2, 'retried exactly once');
});

test('CHATTERBOX_ONLY: never falls back to Fish/espeak, even a hung/failed request stays silent (honest 503) instead of switching voices', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  let fishCalled = false;
  const router = new Router();
  registerVoiceProviderRoutes(router, env.db, {
    env: { CHATTERBOX_URL: 'http://cb.local:8765', CHATTERBOX_ONLY: '1', FISH_AUDIO_API_KEY: 'fish-key' },
    fetchImpl: async (url) => {
      if (String(url).includes('cb.local')) return new Response('fail', { status: 500 });
      fishCalled = true;
      return new Response(new Blob([Buffer.from('FAKE_MP3')]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    },
  });
  const srv = await startServer(router);
  t.after(srv.close);
  const session = createVoiceSession(env.db, 'test', 900);

  const res = await fetch(`${srv.base}/api/voice/tts?session=${session.id}&token=${session.token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'chatterbox is down' }),
  });
  assert.equal(res.status, 503, 'no silent voice-switch — an honest error instead');
  assert.ok(!fishCalled, 'fish is never even tried in CHATTERBOX_ONLY mode');
});

test('chatterbox-fast (MMS): sits between Fish and espeak, used when both Chatterbox and Fish are unavailable', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const calls: string[] = [];
  const router = new Router();
  registerVoiceProviderRoutes(router, env.db, {
    env: { CHATTERBOX_URL: 'http://cb.local:8765' }, // no FISH_AUDIO_API_KEY
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      if (String(url).endsWith('/v1/audio/speech')) return new Response('down', { status: 503 });
      if (String(url).endsWith('/v1/audio/speech/fast')) {
        const sent = JSON.parse(String(init?.body)) as { input: string; language: string; request_id: string };
        assert.equal(sent.input, 'hello there');
        assert.equal(sent.language, 'en');
        assert.ok(sent.request_id);
        return new Response(Buffer.from('RIFF....WAVEfake'), { status: 200, headers: { 'content-type': 'audio/wav' } });
      }
      throw new Error(`unexpected url ${url}`);
    },
  });
  const srv = await startServer(router);
  t.after(srv.close);
  const session = createVoiceSession(env.db, 'test', 900);

  const res = await fetch(`${srv.base}/api/voice/tts?session=${session.id}&token=${session.token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello there', lang: 'en' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-sira-tts-provider'), 'chatterbox-fast');
  assert.deepEqual(calls, [
    'http://cb.local:8765/v1/audio/speech',
    'http://cb.local:8765/v1/audio/speech/fast',
  ], 'quality tier tried first, fast tier second — fish skipped (no key), espeak never reached');
});

test('mintLivekitToken is deterministic and time-bounded', () => {
  const token = mintLivekitToken('k', 's', 'me', 'room', 60, 1000000);
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { exp: number; nbf: number };
  assert.equal(payload.exp, 1000060);
  assert.equal(payload.nbf, 999990);
});
