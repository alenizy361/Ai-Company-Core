// Voice session state machine — the single authority on voice states.
// Every state has legitimate SOURCES: the UI can never manufacture a state
// whose source it does not own (e.g. only real audio capture may set
// 'listening'; only an in-flight model request may set 'thinking'). Invalid
// transitions are recorded (valid=0) and rejected. Voice state is independent
// of task state: the owner can converse while background agents execute.
import type { Db } from '../shared/db.ts';
import { ulid } from '../shared/ids.ts';
import { createHash, randomBytes } from 'node:crypto';

export const VOICE_STATES = [
  'initializing',
  'permission_required',
  'ready',
  'wake_word_listening',
  'connecting',
  'listening',
  'detecting_end_of_turn',
  'transcribing',
  'thinking',
  'calling_tool',
  'creating_plan',
  'executing',
  'waiting_for_approval',
  'generating_speech',
  'speaking',
  'interrupted',
  'reconnecting',
  'muted',
  'offline',
  'failed',
] as const;
export type VoiceState = (typeof VOICE_STATES)[number];

/** Which reporting source is allowed to claim each state. */
export const STATE_SOURCES: Record<VoiceState, string[]> = {
  initializing: ['client_boot'],
  permission_required: ['capture'],
  ready: ['client_boot', 'capture', 'playback', 'server', 'stt', 'tts', 'wake'],
  wake_word_listening: ['wake'],
  connecting: ['transport'],
  listening: ['capture'],
  detecting_end_of_turn: ['turn_detector'],
  transcribing: ['stt'],
  thinking: ['server'],        // only a real in-flight model request
  calling_tool: ['server'],    // only a real dispatched tool call
  creating_plan: ['server'],   // only a real planning run
  executing: ['server'],       // only persisted running executions
  waiting_for_approval: ['server'], // only a pending approvals row
  generating_speech: ['tts'],
  speaking: ['playback'],      // only actually-playing synthesized audio
  interrupted: ['capture', 'playback'],
  reconnecting: ['transport'],
  muted: ['capture'],
  offline: ['transport', 'client_boot'],
  failed: ['capture', 'stt', 'tts', 'transport', 'server'],
};

/** Adjacency: from -> allowed next states. Kept permissive between phases the
 * real providers legitimately produce, strict about fabricated activity. */
const T: Record<VoiceState, VoiceState[]> = {
  initializing: ['permission_required', 'ready', 'offline', 'failed', 'muted'],
  permission_required: ['ready', 'failed', 'offline'],
  ready: ['wake_word_listening', 'connecting', 'listening', 'thinking', 'muted', 'offline', 'failed', 'interrupted'],
  wake_word_listening: ['listening', 'ready', 'muted', 'offline', 'failed'],
  connecting: ['listening', 'ready', 'reconnecting', 'offline', 'failed'],
  listening: ['detecting_end_of_turn', 'transcribing', 'ready', 'muted', 'interrupted', 'failed', 'offline'],
  detecting_end_of_turn: ['listening', 'transcribing', 'ready', 'failed'],
  transcribing: ['thinking', 'listening', 'ready', 'failed'],
  thinking: ['calling_tool', 'creating_plan', 'generating_speech', 'speaking', 'ready', 'failed', 'interrupted', 'executing', 'waiting_for_approval'],
  calling_tool: ['thinking', 'generating_speech', 'ready', 'failed'],
  creating_plan: ['thinking', 'generating_speech', 'speaking', 'ready', 'failed', 'executing'],
  executing: ['ready', 'thinking', 'generating_speech', 'speaking', 'waiting_for_approval', 'failed'],
  waiting_for_approval: ['ready', 'thinking', 'executing', 'generating_speech', 'speaking', 'failed'],
  generating_speech: ['speaking', 'ready', 'failed', 'interrupted'],
  speaking: ['ready', 'interrupted', 'listening', 'failed', 'muted', 'offline'],
  interrupted: ['listening', 'ready', 'transcribing', 'failed'],
  reconnecting: ['ready', 'connecting', 'offline', 'failed'],
  muted: ['ready', 'offline', 'failed'],
  offline: ['initializing', 'ready', 'reconnecting', 'failed'],
  failed: ['initializing', 'ready', 'offline'],
};

export function canTransition(from: VoiceState, to: VoiceState): boolean {
  return T[from]?.includes(to) ?? false;
}

export function sourceAllowed(to: VoiceState, source: string): boolean {
  return STATE_SOURCES[to]?.includes(source) ?? false;
}

export interface TransitionResult {
  accepted: boolean;
  reason?: string;
  from: VoiceState;
  to: VoiceState;
}

export function createVoiceSession(db: Db, clientKind: string, ttlSec: number): { id: string; token: string; availabilityMode: string } {
  const id = ulid('vs');
  const token = randomBytes(24).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  db.run(
    `INSERT INTO voice_sessions (id, client_kind, availability_mode, token_hash, token_expires_at, started_at)
     VALUES (?, ?, 'push_to_talk', ?, ?, ?)`,
    id, clientKind, tokenHash, now + ttlSec * 1000, now,
  );
  db.run(
    `INSERT INTO voice_state_transitions (session_id, from_state, to_state, source, valid, ts)
     VALUES (?, 'initializing', 'initializing', 'client_boot', 1, ?)`,
    id, now,
  );
  return { id, token, availabilityMode: 'push_to_talk' };
}

export function verifyVoiceToken(db: Db, sessionId: string, token: string): boolean {
  const row = db.get<{ token_hash: string | null; token_expires_at: number | null; ended_at: number | null }>(
    'SELECT token_hash, token_expires_at, ended_at FROM voice_sessions WHERE id = ?', sessionId,
  );
  if (!row || row.ended_at || !row.token_hash) return false;
  if ((row.token_expires_at ?? 0) < Date.now()) return false;
  return createHash('sha256').update(token).digest('hex') === row.token_hash;
}

export function currentVoiceState(db: Db, sessionId: string): VoiceState {
  const row = db.get<{ to_state: string }>(
    'SELECT to_state FROM voice_state_transitions WHERE session_id = ? AND valid = 1 ORDER BY seq DESC LIMIT 1',
    sessionId,
  );
  return (row?.to_state as VoiceState) ?? 'initializing';
}

export function recordTransition(db: Db, sessionId: string, to: VoiceState, source: string): TransitionResult {
  const from = currentVoiceState(db, sessionId);
  const now = Date.now();
  let accepted = true;
  let reason: string | undefined;

  if (!VOICE_STATES.includes(to)) {
    accepted = false;
    reason = `unknown state "${to}"`;
  } else if (!sourceAllowed(to, source)) {
    accepted = false;
    reason = `source "${source}" may not claim state "${to}" (allowed: ${STATE_SOURCES[to].join(', ')})`;
  } else if (from !== to && !canTransition(from, to)) {
    accepted = false;
    reason = `illegal transition ${from} -> ${to}`;
  }

  db.run(
    `INSERT INTO voice_state_transitions (session_id, from_state, to_state, source, valid, ts) VALUES (?, ?, ?, ?, ?, ?)`,
    sessionId, from, to, source, accepted ? 1 : 0, now,
  );
  return { accepted, reason, from, to };
}

export function recordVoiceMetric(db: Db, sessionId: string, metric: string, valueMs: number, turnId: string | null): void {
  db.run(
    `INSERT INTO voice_metrics (id, session_id, turn_id, metric, value_ms, ts) VALUES (?, ?, ?, ?, ?, ?)`,
    ulid('vm'), sessionId, turnId, metric, valueMs, Date.now(),
  );
}
