// RABIT OS execution worker. Owns ALL model calls and tool execution:
// planning for open objectives and the agent loop for ready tasks, up to
// maxConcurrentBranches at once. Heartbeats + leases make death visible and
// recovery safe; the CLI adapter is canary-checked before it is trusted.
import { hostname } from 'node:os';
import { openDb } from '../shared/db.ts';
import { loadPaths, loadSystemConfig } from '../shared/config.ts';
import { seedOrgAndAgents } from '../shared/seed.ts';
import { seedPromptsFromDisk } from '../promptreg/registry.ts';
import { ulid } from '../shared/ids.ts';
import { emitEvent } from '../shared/events.ts';
import { selectAdapter } from '../adapters/select.ts';
import { MockAdapter } from '../adapters/mock.ts';
import { runCliCanary } from '../adapters/claude-cli.ts';
import { claimNextPlanningObjective, claimNextTask } from './claims.ts';
import { runExecution } from './execute.ts';
import { runPlanningForObjective } from '../planning/plan-service.ts';
import { sweepExpiredLeases } from './recovery.ts';

const paths = loadPaths();
const cfg = loadSystemConfig();
const db = openDb(paths.dbPath, paths.migrationsDir);
seedOrgAndAgents(db);
seedPromptsFromDisk(db, paths.promptsDir);

const workerId = ulid('wrk');
let shuttingDown = false;
let activeBranches = 0;

async function main(): Promise<void> {
  let selection = selectAdapter();
  if (selection.name === 'claude-cli') {
    const canary = await runCliCanary(paths.varDir);
    if (!canary.ok) {
      console.error(`[worker] CLI canary FAILED — refusing the claude-cli adapter: ${canary.detail}`);
      selection = {
        adapter: new MockAdapter(),
        name: 'mock',
        reason: `claude-cli refused by safety canary: ${canary.detail}`,
      };
    } else {
      console.log(`[worker] CLI ${canary.detail}`);
    }
  }
  const adapter = selection.adapter;
  console.log(`[worker] ${workerId} starting (adapter: ${selection.name} — ${selection.reason})`);

  const now = Date.now();
  db.run(
    `INSERT INTO workers (id, pid, hostname, started_at, last_heartbeat_at, status) VALUES (?, ?, ?, ?, ?, 'online')`,
    workerId, process.pid, hostname(), now, now,
  );
  emitEvent(db, { type: 'worker.online', orgId: cfg.orgId, payload: { workerId, adapter: selection.name, reason: selection.reason } });

  sweepExpiredLeases(db, cfg);

  // Heartbeat: worker row + lease extension for everything this worker holds.
  const heartbeat = setInterval(() => {
    const ts = Date.now();
    try {
      db.run('UPDATE workers SET last_heartbeat_at = ? WHERE id = ?', ts, workerId);
      db.run(`UPDATE tasks SET lease_expires_at = ? WHERE claimed_by = ? AND status IN ('running','waiting_for_tool','waiting_for_approval','verifying')`,
        ts + cfg.leaseMs, workerId);
      db.run(`UPDATE executions SET lease_expires_at = ? WHERE worker_id = ? AND status IN ('running','waiting_for_tool','waiting_for_approval','verifying')`,
        ts + cfg.leaseMs, workerId);
      db.run(`UPDATE objectives SET lease_expires_at = ? WHERE claimed_by = ? AND status = 'planning'`, ts + cfg.leaseMs * 5, workerId);
    } catch (err) {
      console.error('[worker] heartbeat write failed:', err);
    }
  }, cfg.heartbeatMs);

  // Visible heartbeat event (dashboard staleness signal), less frequent.
  const heartbeatEvent = setInterval(() => {
    try {
      emitEvent(db, { type: 'worker.heartbeat', orgId: cfg.orgId, payload: { workerId, activeBranches } });
    } catch { /* next beat retries */ }
  }, 30000);

  const sweeper = setInterval(() => {
    try {
      sweepExpiredLeases(db, cfg);
    } catch (err) {
      console.error('[worker] sweep failed:', err);
    }
  }, cfg.sweepMs);

  const launch = (fn: () => Promise<void>): void => {
    activeBranches++;
    fn()
      .catch((err) => console.error('[worker] branch crashed:', err))
      .finally(() => {
        activeBranches--;
      });
  };

  // Main claim loop.
  while (!shuttingDown) {
    let claimed = false;
    if (activeBranches < cfg.maxConcurrentBranches) {
      try {
        const objective = claimNextPlanningObjective(db, cfg, workerId);
        if (objective) {
          claimed = true;
          console.log(`[worker] planning objective ${objective.id}: ${objective.title}`);
          launch(async () => {
            const outcome = await runPlanningForObjective(db, adapter, objective.id);
            console.log(`[worker] planning ${objective.id} -> ${outcome.status}`);
          });
        } else {
          const task = claimNextTask(db, cfg, workerId);
          if (task) {
            claimed = true;
            console.log(`[worker] executing task ${task.id} (${task.agent_key}: ${task.title}) attempt ${task.attempt_count}`);
            launch(async () => {
              const outcome = await runExecution(db, cfg, paths, adapter, task, workerId);
              console.log(`[worker] task ${task.id} -> ${outcome}`);
            });
          }
        }
      } catch (err) {
        console.error('[worker] claim failed:', err);
      }
    }
    await new Promise((r) => setTimeout(r, claimed ? 100 : 1000));
  }

  clearInterval(heartbeat);
  clearInterval(heartbeatEvent);
  clearInterval(sweeper);
}

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[worker] shutting down');
  try {
    db.run(`UPDATE workers SET status = 'stopped' WHERE id = ?`, workerId);
    emitEvent(db, { type: 'worker.offline', orgId: cfg.orgId, payload: { workerId } });
  } catch { /* best effort */ }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
