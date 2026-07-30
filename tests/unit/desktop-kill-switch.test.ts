import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { makeEnv } from '../helpers/fixtures.ts';
import { isKilled, kill, resume, lockFilePath } from '../../src/desktop-bridge/kill-switch.ts';
import { getSetting } from '../../src/shared/settings.ts';

test('kill-switch: starts un-killed; kill() writes the lock file and armed=false; resume() clears it', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());

  assert.equal(isKilled(env.paths), false, 'fresh env starts un-killed');

  kill(env.db, env.paths, env.cfg.orgId, 'test emergency stop');
  assert.equal(isKilled(env.paths), true);
  assert.ok(existsSync(lockFilePath(env.paths)));
  assert.equal(getSetting(env.db, 'desktop_bridge.armed'), 'false');

  resume(env.db, env.paths, env.cfg.orgId);
  assert.equal(isKilled(env.paths), false);
  assert.ok(!existsSync(lockFilePath(env.paths)));
  assert.equal(getSetting(env.db, 'desktop_bridge.armed'), 'true');
});

test('kill-switch: kill() audits and notifies with critical priority; resume() with normal priority', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());

  kill(env.db, env.paths, env.cfg.orgId, 'owner hit the emergency stop');
  const killAudit = env.db.get<{ action: string }>(`SELECT action FROM audit_logs WHERE action = 'desktop_bridge.kill' ORDER BY created_at DESC LIMIT 1`);
  assert.ok(killAudit, 'kill() writes an audit_logs row');
  const killNotif = env.db.get<{ priority: string; title: string }>(`SELECT priority, title FROM notifications WHERE kind = 'desktop_bridge_killed' ORDER BY created_at DESC LIMIT 1`);
  assert.ok(killNotif);
  assert.equal(killNotif!.priority, 'critical');

  resume(env.db, env.paths, env.cfg.orgId);
  const resumeAudit = env.db.get<{ action: string }>(`SELECT action FROM audit_logs WHERE action = 'desktop_bridge.resume' ORDER BY created_at DESC LIMIT 1`);
  assert.ok(resumeAudit);
  const resumeNotif = env.db.get<{ priority: string }>(`SELECT priority FROM notifications WHERE kind = 'desktop_bridge_resumed' ORDER BY created_at DESC LIMIT 1`);
  assert.ok(resumeNotif);
  assert.equal(resumeNotif!.priority, 'normal');
});

test('kill-switch: resume() on an already-un-killed session is a safe no-op (idempotent)', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());

  assert.equal(isKilled(env.paths), false);
  resume(env.db, env.paths, env.cfg.orgId); // must not throw when there's nothing to remove
  assert.equal(isKilled(env.paths), false);
});
