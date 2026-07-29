// Voice session lifecycle routes: short-lived scoped session tokens, source-
// attributed state transitions (invalid ones recorded + rejected), latency
// metrics, and honest teardown. The server validates every transition against
// the state machine — the UI cannot manufacture states it does not own.
import type { Db } from '../../shared/db.ts';
import type { Router } from '../router.ts';
import { json, errorJson } from '../router.ts';
import { loadVoiceConfig } from '../../shared/config.ts';
import {
  createVoiceSession, currentVoiceState, recordTransition, recordVoiceMetric, verifyVoiceToken,
  type VoiceState,
} from '../../voice/session.ts';

export function registerVoiceRoutes(router: Router, db: Db): void {
  const voiceCfg = loadVoiceConfig();

  router.post('/api/voice-session', ({ res, body }) => {
    const clientKind = String((body as { clientKind?: string } | undefined)?.clientKind ?? 'web');
    const session = createVoiceSession(db, clientKind, voiceCfg.sessionTokenTtlSec);
    json(res, 201, {
      id: session.id,
      token: session.token,
      ttlSec: voiceCfg.sessionTokenTtlSec,
      availabilityMode: session.availabilityMode,
      turn: voiceCfg.turn,
    });
  });

  router.post('/api/voice-session/:id/transition', ({ res, params, body }) => {
    const b = body as { to?: string; source?: string; token?: string } | undefined;
    if (!b?.token || !verifyVoiceToken(db, params.id, b.token)) {
      return errorJson(res, 401, 'UNAUTHORIZED', 'invalid or expired voice session token');
    }
    if (!b.to || !b.source) return errorJson(res, 400, 'BAD_REQUEST', 'to and source are required');
    const result = recordTransition(db, params.id, b.to as VoiceState, b.source);
    json(res, result.accepted ? 200 : 422, result);
  });

  router.get('/api/voice-session/:id/state', ({ res, params }) => {
    json(res, 200, { state: currentVoiceState(db, params.id) });
  });

  router.post('/api/voice-session/:id/metrics', ({ res, params, body }) => {
    const b = body as { token?: string; metrics?: { metric: string; value_ms: number; turn_id?: string }[] } | undefined;
    if (!b?.token || !verifyVoiceToken(db, params.id, b.token)) {
      return errorJson(res, 401, 'UNAUTHORIZED', 'invalid or expired voice session token');
    }
    for (const m of b.metrics ?? []) {
      if (typeof m.metric === 'string' && typeof m.value_ms === 'number') {
        recordVoiceMetric(db, params.id, m.metric, m.value_ms, m.turn_id ?? null);
      }
    }
    json(res, 200, { ok: true });
  });

  router.post('/api/voice-session/:id/mode', ({ res, params, body }) => {
    const b = body as { token?: string; mode?: string } | undefined;
    if (!b?.token || !verifyVoiceToken(db, params.id, b.token)) {
      return errorJson(res, 401, 'UNAUTHORIZED', 'invalid or expired voice session token');
    }
    const mode = String(b.mode ?? '');
    if (!['push_to_talk', 'hold', 'continuous'].includes(mode)) {
      return errorJson(res, 400, 'BAD_REQUEST', 'mode must be push_to_talk | hold | continuous');
    }
    db.run('UPDATE voice_sessions SET availability_mode = ? WHERE id = ?', mode, params.id);
    json(res, 200, { ok: true, mode });
  });

  router.post('/api/voice-session/:id/end', ({ res, params, body }) => {
    const b = body as { token?: string } | undefined;
    if (!b?.token || !verifyVoiceToken(db, params.id, b.token)) {
      return errorJson(res, 401, 'UNAUTHORIZED', 'invalid or expired voice session token');
    }
    db.run('UPDATE voice_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL', Date.now(), params.id);
    json(res, 200, { ok: true });
  });

  router.get('/api/voice-metrics', ({ res, query }) => {
    const sessionId = query.get('session');
    const rows = sessionId
      ? db.all(
          `SELECT metric, COUNT(*) AS n, AVG(value_ms) AS avg_ms, MIN(value_ms) AS min_ms, MAX(value_ms) AS max_ms
           FROM voice_metrics WHERE session_id = ? GROUP BY metric`, sessionId)
      : db.all(
          `SELECT metric, COUNT(*) AS n, AVG(value_ms) AS avg_ms, MIN(value_ms) AS min_ms, MAX(value_ms) AS max_ms
           FROM voice_metrics GROUP BY metric`);
    json(res, 200, rows);
  });
}
