// GET /api/health — real checks only: database round-trip, worker heartbeat
// freshness, SSE client count, selected model adapter (+ why), voice provider
// matrix. Nothing here reports healthy without actually checking.
import type { Db } from '../../shared/db.ts';
import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { SseHub } from '../sse.ts';
import type { SystemConfig } from '../../shared/config.ts';
import { loadVoiceConfig } from '../../shared/config.ts';
import { espeakBin, fishConfigured, chatterboxState } from './voice-providers.ts';

export interface AdapterInfo {
  name: string;
  reason: string;
  model?: string;
}

export function registerHealthRoute(
  router: Router,
  db: Db,
  hub: SseHub,
  cfg: SystemConfig,
  getAdapterInfo: () => AdapterInfo,
  getEngineInfo?: () => { name: string; reason: string },
  getBuildId?: () => string,
): void {
  router.get('/api/health', async ({ res }) => {
    const now = Date.now();
    let dbOk = false;
    let dbError: string | null = null;
    try {
      db.get('SELECT 1 AS ok');
      dbOk = true;
    } catch (err) {
      dbError = err instanceof Error ? err.message : String(err);
    }

    const workers = dbOk
      ? db.all<{ id: string; last_heartbeat_at: number; status: string; adapter: string | null; adapter_reason: string | null }>(
          `SELECT id, last_heartbeat_at, status, adapter, adapter_reason FROM workers WHERE last_heartbeat_at > ? ORDER BY last_heartbeat_at DESC`,
          now - cfg.staleWorkerMs * 4,
        )
      : [];
    const freshWorkers = workers.filter((w) => w.status === 'online' && w.last_heartbeat_at > now - cfg.staleWorkerMs);
    // Adapter truth: the LIVE worker's recorded adapter wins over the API
    // server's own environment probe — the two processes can disagree (e.g.
    // the worker's systemd PATH misses the claude binary and it silently
    // degraded to mock while this server still sees a healthy CLI).
    const workerAdapter = freshWorkers.find((w) => w.adapter);

    // Chatterbox is opt-in and local — "configured" (CHATTERBOX_URL set,
    // CHATTERBOX_ENABLED not 'off') and "actually answering" are different
    // facts, and reporting the former as the latter is exactly the kind of
    // fake state this endpoint exists to rule out. A live /ready probe with a
    // short timeout keeps this honest without materially slowing the health
    // check. Gated on chatterboxState().enabled, not just CHATTERBOX_URL, so
    // a service that is live but CHATTERBOX_ENABLED=off (never actually used
    // by /api/voice/tts) is not reported as the active voice either.
    const chatterbox = chatterboxState(process.env);
    let chatterboxLive = false;
    if (chatterbox.enabled) {
      try {
        const probe = await fetch(`${chatterbox.url}/ready`, { signal: AbortSignal.timeout(800) });
        chatterboxLive = probe.ok;
      } catch {
        chatterboxLive = false;
      }
    }

    const voiceCfg = loadVoiceConfig();
    const voiceProviders = {
      stt: process.env[voiceCfg.providers.stt.keyEnv] ? voiceCfg.providers.stt.primary : voiceCfg.providers.stt.fallback,
      // Real relay order (src/server/routes/voice-providers.ts): Chatterbox
      // (local, opt-in) -> Fish Audio -> espeak-ng -> browser
      // speechSynthesis. Report whichever tier will actually answer right now.
      // CHATTERBOX_ONLY means a Chatterbox outage is total silence, not a
      // fallback to Fish/espeak — reporting either of those here would be a lie.
      tts: chatterboxLive
        ? 'chatterbox'
        : chatterbox.only
          ? 'none'
          : fishConfigured(process.env)
            ? voiceCfg.providers.tts.primary
            : espeakBin() ? 'espeak' : voiceCfg.providers.tts.fallback,
      wake: process.env[voiceCfg.providers.wake.keyEnv] ? voiceCfg.providers.wake.primary : voiceCfg.providers.wake.fallback,
      transport: voiceCfg.providers.transport.keyEnvs.every((e) => process.env[e])
        ? voiceCfg.providers.transport.primary
        : voiceCfg.providers.transport.fallback,
      ...(process.env.CHATTERBOX_URL ? { chatterboxConfigured: chatterbox.enabled, chatterboxLive } : {}),
    };

    const pendingApprovals = dbOk
      ? db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`)?.n ?? 0
      : 0;
    const lastEvent = dbOk
      ? db.get<{ seq: number; created_at: number } | undefined>(
          'SELECT seq, created_at FROM execution_events ORDER BY seq DESC LIMIT 1',
        )
      : undefined;

    json(res, 200, {
      ok: dbOk,
      serverTime: now,
      db: { ok: dbOk, error: dbError },
      worker: {
        online: freshWorkers.length > 0,
        count: freshWorkers.length,
        lastHeartbeatAt: workers[0]?.last_heartbeat_at ?? null,
        staleAfterMs: cfg.staleWorkerMs,
      },
      sse: { clients: hub.clientCount(), lastSeq: hub.lastSeq(), lastEventAt: lastEvent?.created_at ?? null },
      adapter: workerAdapter
        ? { name: workerAdapter.adapter as string, reason: `${workerAdapter.adapter_reason ?? ''} (reported by the live worker)` }
        : getAdapterInfo(),
      // Which conversation engine answers /api/converse (agent-sdk | legacy).
      engine: getEngineInfo?.() ?? null,
      // Interface build fingerprint — the client self-reloads when it changes.
      build: getBuildId?.() ?? null,
      voiceProviders,
      pendingApprovals,
    });
  });
}
