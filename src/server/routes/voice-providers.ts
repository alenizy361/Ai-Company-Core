// External voice provider integrations — server-proxied so provider keys
// NEVER reach the browser. Each endpoint requires a valid voice-session token
// and answers 503 PROVIDER_NOT_CONFIGURED (with the exact env var needed)
// until its key exists; the client then keeps its browser-native fallback.
//
//   POST /api/voice/stt           audio bytes -> Deepgram transcription
//   POST /api/voice/tts           text -> synthesized audio: Fish Audio when
//                                 keyed, else local espeak-ng when installed
//                                 (zero-key voice — browsers on Linux often
//                                 ship no speechSynthesis voices at all)
//   POST /api/voice/livekit-token mint a LiveKit room JWT (HS256, node:crypto)
//   POST /api/voice/wake-key      Porcupine access key for on-device wake word
import { createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import type { Db } from '../../shared/db.ts';
import type { Router } from '../router.ts';
import { json, errorJson } from '../router.ts';
import { verifyVoiceToken } from '../../voice/session.ts';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface VoiceProviderDeps {
  fetchImpl?: FetchLike; // injectable for fixture tests
  env?: Record<string, string | undefined>;
  /** Override local-TTS detection in tests (default: probe for espeak-ng). */
  localTts?: boolean;
}

let espeakBinCache: string | null | undefined;

/** Local zero-key TTS: espeak-ng (or espeak) if installed on this machine. */
export function espeakBin(): string | null {
  if (espeakBinCache !== undefined) return espeakBinCache;
  for (const bin of ['espeak-ng', 'espeak']) {
    const res = spawnSync(bin, ['--version'], { timeout: 5000 });
    if (!res.error && res.status === 0) {
      espeakBinCache = bin;
      return bin;
    }
  }
  espeakBinCache = null;
  return null;
}

function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('audio too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Minimal HS256 JWT for LiveKit access tokens (no SDK needed). */
export function mintLivekitToken(apiKey: string, apiSecret: string, identity: string, room: string, ttlSec: number, nowSec: number): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: apiKey,
    sub: identity,
    nbf: nowSec - 10,
    exp: nowSec + ttlSec,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true },
  }));
  const signature = createHmac('sha256', apiSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function registerVoiceProviderRoutes(router: Router, db: Db, deps: VoiceProviderDeps = {}): void {
  const env = deps.env ?? process.env;
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));

  const requireSession = (query: URLSearchParams, res: Parameters<typeof json>[0]): boolean => {
    const sessionId = query.get('session') ?? '';
    const token = query.get('token') ?? '';
    if (!verifyVoiceToken(db, sessionId, token)) {
      errorJson(res, 401, 'UNAUTHORIZED', 'valid voice session + token required');
      return false;
    }
    return true;
  };

  // ---- Deepgram STT (turn-based: one recorded utterance per request) ----
  router.post('/api/voice/stt', async ({ req, res, query }) => {
    if (!requireSession(query, res)) return;
    const key = env.DEEPGRAM_API_KEY;
    if (!key) return errorJson(res, 503, 'PROVIDER_NOT_CONFIGURED', 'set DEEPGRAM_API_KEY to enable Deepgram STT; the client falls back to Web Speech');
    let audio: Buffer;
    try {
      audio = await readRawBody(req, 10_000_000);
    } catch (err) {
      return errorJson(res, 413, 'TOO_LARGE', err instanceof Error ? err.message : 'audio too large');
    }
    if (audio.length < 100) return errorJson(res, 400, 'BAD_REQUEST', 'no audio received');
    const lang = query.get('lang') === 'ar' ? 'ar' : query.get('lang') === 'en' ? 'en' : 'multi';
    const mime = req.headers['content-type'] ?? 'audio/webm';
    try {
      const upstream = await fetchImpl(
        `https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=${lang}`,
        { method: 'POST', headers: { Authorization: `Token ${key}`, 'Content-Type': String(mime) }, body: audio as unknown as RequestInit['body'] },
      );
      if (!upstream.ok) {
        return errorJson(res, 502, 'PROVIDER_ERROR', `Deepgram ${upstream.status}: ${(await upstream.text()).slice(0, 300)}`);
      }
      const data = (await upstream.json()) as {
        results?: { channels?: { alternatives?: { transcript?: string; confidence?: number }[] }[] };
      };
      const alt = data.results?.channels?.[0]?.alternatives?.[0];
      json(res, 200, { provider: 'deepgram', text: alt?.transcript ?? '', confidence: alt?.confidence ?? null });
    } catch (err) {
      errorJson(res, 502, 'PROVIDER_ERROR', err instanceof Error ? err.message : String(err));
    }
  });

  // ---- TTS relay: Fish Audio when keyed (falling back to local espeak on
  // upstream failure, e.g. no API credit), else local espeak-ng ----
  const synthLocal = (res: Parameters<typeof json>[0], text: string, viaFallback: boolean): void => {
    // Local synthesis: honest, offline, Arabic-aware. WAV streamed as it is
    // generated; the voice follows the text's language.
    const bin = espeakBin()!;
    const isArabic = /[؀-ۿ]/.test(text);
    const child = spawn(bin, ['--stdin', '--stdout', '-v', isArabic ? 'ar' : 'en-us', '-s', '165']);
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'cache-control': 'no-store',
      'x-sira-tts-provider': viaFallback ? 'espeak-fallback' : 'espeak',
    });
    child.stdout.pipe(res);
    child.on('error', () => {
      if (!res.headersSent) errorJson(res, 502, 'PROVIDER_ERROR', 'local TTS failed to start');
      else res.end();
    });
    child.stdin.write(text.slice(0, 2000));
    child.stdin.end();
  };

  router.post('/api/voice/tts', async ({ res, query, body }) => {
    if (!requireSession(query, res)) return;
    const key = env.FISH_AUDIO_API_KEY;
    const text = (body as { text?: string } | undefined)?.text;
    if (!text || typeof text !== 'string') return errorJson(res, 400, 'BAD_REQUEST', 'text is required');
    const localOk = deps.localTts ?? espeakBin() !== null;
    if (!key) {
      if (!localOk) {
        return errorJson(res, 503, 'PROVIDER_NOT_CONFIGURED',
          'no server voice: set FISH_AUDIO_API_KEY, or install espeak-ng (sudo apt install espeak-ng); the client falls back to speechSynthesis');
      }
      return synthLocal(res, text, false);
    }
    try {
      const upstream = await fetchImpl('https://api.fish.audio/v1/tts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          // s2.1-pro-free: Fish Audio's free API tier (through Aug 2026) —
          // works with a keyed account holding zero API credit. Owners with
          // paid credit can pick a paid model via FISH_AUDIO_MODEL.
          model: env.FISH_AUDIO_MODEL ?? 's2.1-pro-free',
        },
        body: JSON.stringify({ text: text.slice(0, 2000), format: 'mp3', latency: 'balanced' }),
      });
      if (!upstream.ok || !upstream.body) {
        const detail = `Fish Audio ${upstream.status}: ${(await upstream.text()).slice(0, 300)}`;
        // A keyed-but-failing provider (e.g. out of API credit) must not
        // silence the voice when a local one exists.
        if (localOk) {
          console.warn(`[sira] tts falling back to local voice — ${detail}`);
          return synthLocal(res, text, true);
        }
        return errorJson(res, 502, 'PROVIDER_ERROR', detail);
      }
      res.writeHead(200, {
        'content-type': upstream.headers.get('content-type') ?? 'audio/mpeg',
        'cache-control': 'no-store',
        'x-sira-tts-provider': 'fish-audio',
      });
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        if (localOk) return synthLocal(res, text, true);
        errorJson(res, 502, 'PROVIDER_ERROR', err instanceof Error ? err.message : String(err));
      } else res.end();
    }
  });

  // ---- LiveKit transport token ----
  router.post('/api/voice/livekit-token', ({ res, query }) => {
    if (!requireSession(query, res)) return;
    const url = env.LIVEKIT_URL;
    const apiKey = env.LIVEKIT_API_KEY;
    const apiSecret = env.LIVEKIT_API_SECRET;
    if (!url || !apiKey || !apiSecret) {
      return errorJson(res, 503, 'PROVIDER_NOT_CONFIGURED', 'set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET to enable the LiveKit transport; the client keeps in-page capture');
    }
    const token = mintLivekitToken(apiKey, apiSecret, `owner-${query.get('session')}`, 'sira-voice', 3600, Math.floor(Date.now() / 1000));
    json(res, 200, { provider: 'livekit', url, token, room: 'sira-voice' });
  });

  // ---- Porcupine wake-word access key (on-device processing needs it client-side) ----
  router.post('/api/voice/wake-key', ({ res, query }) => {
    if (!requireSession(query, res)) return;
    const key = env.PICOVOICE_ACCESS_KEY;
    if (!key) return errorJson(res, 503, 'PROVIDER_NOT_CONFIGURED', 'set PICOVOICE_ACCESS_KEY to enable on-device wake word; the client stays push-to-talk');
    json(res, 200, { provider: 'porcupine', accessKey: key, note: 'wake-word audio is processed on-device; nothing streams before activation' });
  });
}
