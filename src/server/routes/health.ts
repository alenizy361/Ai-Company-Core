// GET /api/health — real checks only: database round-trip, worker heartbeat
// freshness, SSE client count, selected model adapter (+ why), voice provider
// matrix. Nothing here reports healthy without actually checking.
import type { Db } from '../../shared/db.ts';
import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { SseHub } from '../sse.ts';
import type { SystemConfig } from '../../shared/config.ts';
import { loadVoiceConfig } from '../../shared/config.ts';
import { espeakBin } from './voice-providers.ts';

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
): void {
  router.get('/api/health', ({ res }) => {
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

    const voiceCfg = loadVoiceConfig();
    const voiceProviders = {
      stt: process.env[voiceCfg.providers.stt.keyEnv] ? voiceCfg.providers.stt.primary : voiceCfg.providers.stt.fallback,
      tts: process.env[voiceCfg.providers.tts.keyEnv]
        ? voiceCfg.providers.tts.primary
        : espeakBin() ? 'espeak' : voiceCfg.providers.tts.fallback,
      wake: process.env[voiceCfg.providers.wake.keyEnv] ? voiceCfg.providers.wake.primary : voiceCfg.providers.wake.fallback,
      transport: voiceCfg.providers.transport.keyEnvs.every((e) => process.env[e])
        ? voiceCfg.providers.transport.primary
        : voiceCfg.providers.transport.fallback,
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
      voiceProviders,
      pendingApprovals,
    });
  });
}
