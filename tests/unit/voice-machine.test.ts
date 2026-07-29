import { test } from 'node:test';
import assert from 'node:assert';
import { makeEnv } from '../helpers/fixtures.ts';
import { createVoiceSession, recordTransition, currentVoiceState, verifyVoiceToken } from '../../src/voice/session.ts';

test('voice state machine: source attribution + legality + persistence', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const session = createVoiceSession(env.db, 'test', 900);

  // Legal path claimed by legitimate sources.
  assert.ok(recordTransition(env.db, session.id, 'ready', 'client_boot').accepted);
  assert.ok(recordTransition(env.db, session.id, 'listening', 'capture').accepted);
  assert.ok(recordTransition(env.db, session.id, 'transcribing', 'stt').accepted);
  assert.ok(recordTransition(env.db, session.id, 'thinking', 'server').accepted);

  // The UI (client_boot) may NEVER claim speaking; only real playback may.
  const fabricated = recordTransition(env.db, session.id, 'speaking', 'client_boot');
  assert.equal(fabricated.accepted, false);
  assert.match(fabricated.reason ?? '', /may not claim/);
  assert.equal(currentVoiceState(env.db, session.id), 'thinking');

  // Only a real model request source sets thinking — stt cannot.
  const wrongSource = recordTransition(env.db, session.id, 'thinking', 'stt');
  assert.equal(wrongSource.accepted, false);

  // Illegal jump even with a legitimate source.
  const illegal = recordTransition(env.db, session.id, 'transcribing', 'stt');
  assert.equal(illegal.accepted, false);
  assert.match(illegal.reason ?? '', /illegal transition/);

  // Invalid attempts are persisted with valid=0 (auditable).
  const invalidRows = env.db.all<{ valid: number }>(
    'SELECT valid FROM voice_state_transitions WHERE session_id = ? AND valid = 0', session.id,
  );
  assert.equal(invalidRows.length, 3);
});

test('voice session tokens: hashed, expiring, verifiable', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const session = createVoiceSession(env.db, 'test', 900);
  assert.ok(verifyVoiceToken(env.db, session.id, session.token));
  assert.ok(!verifyVoiceToken(env.db, session.id, 'wrong-token'));
  // Token is stored only as a hash.
  const row = env.db.get<{ token_hash: string }>('SELECT token_hash FROM voice_sessions WHERE id = ?', session.id);
  assert.notEqual(row?.token_hash, session.token);
  // Expired token fails.
  env.db.run('UPDATE voice_sessions SET token_expires_at = ? WHERE id = ?', Date.now() - 1000, session.id);
  assert.ok(!verifyVoiceToken(env.db, session.id, session.token));
});
