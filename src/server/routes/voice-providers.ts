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

/**
 * Sticky TTS provider per voice session. A single spoken reply is synthesized
 * sentence-by-sentence (progressive TTS); without this, one sentence landing
 * on Chatterbox/Fish and the next falling back to espeak (or a per-sentence
 * language re-detection) made ONE reply sound like several different voices
 * talking in turn — the "voice changed" / "three replies in a row" symptom.
 * The first sentence of a turn picks a provider; every sentence within
 * STICKY_MS of the last one reuses it. A provider is allowed to switch
 * (once, forward only — never oscillates back) only when it actually fails;
 * silence never happens because the chain always ends at espeak if installed.
 */
const STICKY_MS = 45_000;
type TtsProvider = 'chatterbox' | 'fish-audio' | 'chatterbox-fast' | 'espeak';
const DEFAULT_ORDER: TtsProvider[] = ['chatterbox', 'fish-audio', 'chatterbox-fast', 'espeak'];
const stickyProvider = new Map<string, { provider: TtsProvider; at: number }>();

function getSticky(sessionId: string): TtsProvider | null {
  const entry = stickyProvider.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.at > STICKY_MS) {
    stickyProvider.delete(sessionId);
    return null;
  }
  return entry.provider;
}

function setSticky(sessionId: string, provider: TtsProvider): void {
  stickyProvider.set(sessionId, { provider, at: Date.now() });
}

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
  //
  // Voice language: the client sends the segment's language; without it we
  // detect the DOMINANT script (a single Arabic name inside an English
  // sentence must not flip the whole sentence to the Arabic voice — the old
  // any-char test did exactly that).
  const dominantLang = (text: string): 'ar' | 'en' => {
    const arabic = (text.match(/[؀-ۿݐ-ݿ]/g) ?? []).length;
    const latin = (text.match(/[A-Za-z]/g) ?? []).length;
    return arabic > latin ? 'ar' : 'en';
  };
  const synthLocal = (res: Parameters<typeof json>[0], text: string, lang: 'ar' | 'en', viaFallback: boolean): void => {
    // Local synthesis: honest, offline, Arabic-aware. WAV streamed as it is
    // generated; the voice follows the segment's language.
    const bin = espeakBin()!;
    const child = spawn(bin, ['--stdin', '--stdout', '-v', lang === 'ar' ? 'ar' : 'en-us', '-s', '165']);
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

  // Chatterbox Multilingual V3: an optional persistent local TTS service
  // (see docs — one model instance, one custom voice, CPU-only) reached at
  // CHATTERBOX_URL (default http://127.0.0.1:8765). When it answers, it is
  // the highest-quality and zero-cost option, so it is tried first.
  const chatterboxUrl = env.CHATTERBOX_URL ?? '';
  const chatterboxEnabled = Boolean(chatterboxUrl) && env.CHATTERBOX_ENABLED !== 'off';
  // Owner choice: Chatterbox as the ONLY voice, no Fish/espeak fallback at
  // all — a failed sentence stays silent (the text reply still arrives)
  // rather than ever switching to a different-sounding voice. Since there is
  // nothing to fall back to, fail-fast no longer makes sense here — a
  // genuinely slow-but-working CPU generation should be given the time to
  // finish rather than being aborted into silence. CHATTERBOX_TIMEOUT_MS
  // overrides either default explicitly (e.g. after measuring real RTF).
  const chatterboxOnly = chatterboxEnabled && (env.CHATTERBOX_ONLY === '1' || env.CHATTERBOX_ONLY === 'on');
  const chatterboxTimeoutMs = Number(env.CHATTERBOX_TIMEOUT_MS) > 0
    ? Number(env.CHATTERBOX_TIMEOUT_MS)
    : chatterboxOnly ? 30_000 : 6_000;
  const synthChatterbox = async (
    res: Parameters<typeof json>[0], text: string, lang: 'ar' | 'en', requestId: string,
  ): Promise<boolean> => {
    try {
      const upstream = await fetchImpl(`${chatterboxUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'chatterbox-multilingual-v3',
          input: text.slice(0, 400),
          voice: env.CHATTERBOX_VOICE ?? 'default',
          language: lang,
          response_format: 'wav',
          request_id: requestId,
        }),
        // Chatterbox is CPU inference and can genuinely be slow (measured,
        // not assumed — real-time factor varies by machine). A voice
        // assistant that goes silent for too long LOOKS like it stopped
        // responding. When a fallback exists, fail fast and let it answer;
        // in CHATTERBOX_ONLY mode there is no fallback, so we wait longer.
        signal: AbortSignal.timeout(chatterboxTimeoutMs),
      });
      if (!upstream.ok || !upstream.body) return false;
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'cache-control': 'no-store',
        'x-sira-tts-provider': 'chatterbox',
      });
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
      return true;
    } catch {
      return false; // service not running / unreachable — fall through
    }
  };

  // Fast tier of the SAME local service: facebook/mms-tts-{ara,eng} (VITS,
  // single feed-forward pass — no diffusion/flow-matching steps, so it stays
  // fast on CPU even when Chatterbox itself is too slow). A real neural
  // voice, not espeak's formant synthesis — sits between Chatterbox (quality)
  // and espeak (always-available last resort) in the default chain.
  const synthChatterboxFast = async (
    res: Parameters<typeof json>[0], text: string, lang: 'ar' | 'en', requestId: string,
  ): Promise<boolean> => {
    try {
      const upstream = await fetchImpl(`${chatterboxUrl}/v1/audio/speech/fast`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: text.slice(0, 400), language: lang, request_id: requestId }),
        // Expected to be genuinely fast (single feed-forward pass); if it
        // isn't, fail fast into espeak rather than stalling the reply.
        signal: AbortSignal.timeout(6_000),
      });
      if (!upstream.ok || !upstream.body) return false;
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'cache-control': 'no-store',
        'x-sira-tts-provider': 'chatterbox-fast',
      });
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
      return true;
    } catch {
      return false;
    }
  };

  router.post('/api/voice/tts', async ({ res, query, body }) => {
    if (!requireSession(query, res)) return;
    // FISH_API_KEY is the canonical name; FISH_AUDIO_API_KEY remains accepted
    // for existing deployments. The key never leaves the server.
    const key = env.FISH_API_KEY ?? env.FISH_AUDIO_API_KEY;
    const b = body as { text?: string; lang?: string } | undefined;
    const text = b?.text;
    if (!text || typeof text !== 'string') return errorJson(res, 400, 'BAD_REQUEST', 'text is required');
    const lang: 'ar' | 'en' = b?.lang === 'ar' ? 'ar' : b?.lang === 'en' ? 'en' : dominantLang(text);
    const localOk = deps.localTts ?? espeakBin() !== null;
    const sessionId = query.get('session') ?? '';
    const requestId = `${sessionId}-${Date.now()}`;

    const fishAttempt = async (): Promise<boolean> => {
      const referenceId = (lang === 'ar' ? env.FISH_AUDIO_VOICE_AR : env.FISH_AUDIO_VOICE_EN) ?? env.FISH_AUDIO_VOICE;
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
        body: JSON.stringify({
          text: text.slice(0, 2000), format: 'mp3', latency: 'balanced',
          ...(referenceId ? { reference_id: referenceId } : {}),
        }),
        // This request previously had NO timeout at all: an upstream stall
        // hung here forever, the client's TTS queue stayed stuck on
        // "generating speech" indefinitely, and the reply looked like SIRA
        // had simply stopped responding (even though the text reply had
        // already arrived over SSE — only the SPOKEN half was dead).
        signal: AbortSignal.timeout(6_000),
      });
      if (!upstream.ok || !upstream.body) return false;
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
      return true;
    };

    const doFish = async (): Promise<boolean> => {
      if (!key) return false;
      // One immediate retry before conceding the sentence to a lower-quality
      // provider: a single transient blip (timeout, dropped connection) must
      // not permanently downgrade the REST of the reply to espeak for the
      // whole sticky window — that read as "the voice changed and stayed
      // changed" even though Fish Audio was fine again one request later.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (await fishAttempt()) return true;
        } catch {
          // Headers already committed means audio was mid-stream when the
          // upstream connection dropped — the response can no longer switch
          // provider (that would corrupt the stream), so stop retrying and
          // just end it rather than falling through to espeak on top of it.
          if (res.headersSent) {
            try { res.end(); } catch { /* already closed */ }
            return true;
          }
        }
      }
      return false;
    };

    // Sticky selection: within one spoken reply, reuse whichever provider
    // answered the previous sentence instead of re-probing the whole chain
    // (re-probing is what made a single answer flip between voices).
    // CHATTERBOX_ONLY overrides everything else: the owner explicitly chose
    // one steady local voice over silence-avoidance — never let a Chatterbox
    // failure fall through to a different-sounding voice.
    const sticky = sessionId ? getSticky(sessionId) : null;
    const order: TtsProvider[] = chatterboxOnly
      ? ['chatterbox']
      : sticky
        ? [sticky, ...DEFAULT_ORDER.filter((p) => p !== sticky)]
        : DEFAULT_ORDER;

    for (const provider of order) {
      if (provider === 'chatterbox') {
        if (!chatterboxEnabled) continue;
        if (await synthChatterbox(res, text, lang, requestId)) {
          if (sessionId) setSticky(sessionId, 'chatterbox');
          return;
        }
      } else if (provider === 'fish-audio') {
        if (await doFish()) {
          if (sessionId) setSticky(sessionId, 'fish-audio');
          return;
        }
      } else if (provider === 'chatterbox-fast') {
        if (!chatterboxEnabled) continue;
        if (await synthChatterboxFast(res, text, lang, requestId)) {
          if (sessionId) setSticky(sessionId, 'chatterbox-fast');
          return;
        }
      } else if (localOk) {
        if (sessionId) setSticky(sessionId, 'espeak');
        return synthLocal(res, text, lang, provider !== order[0]);
      }
    }
    if (chatterboxOnly) {
      return errorJson(res, 503, 'PROVIDER_ERROR',
        'Chatterbox did not answer in time and CHATTERBOX_ONLY disables the Fish/espeak fallback — the text reply still arrived, this sentence just has no audio');
    }
    return errorJson(res, 503, 'PROVIDER_NOT_CONFIGURED',
      'no server voice: run the local Chatterbox service, set FISH_AUDIO_API_KEY, or install espeak-ng (sudo apt install espeak-ng); the client falls back to speechSynthesis');
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
