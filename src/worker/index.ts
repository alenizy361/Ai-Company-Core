// SIRA OS execution worker. Owns ALL model calls and tool execution:
// planning for open objectives and the agent loop for ready tasks, up to
// maxConcurrentBranches at once. Heartbeats + leases make death visible and
// recovery safe; the CLI adapter is canary-checked before it is trusted.
import { hostname } from 'node:os';
import { openDb } from '../shared/db.ts';
import { loadPaths, loadSystemConfig } from '../shared/config.ts';
import { seedOrgAndAgents } from '../shared/seed.ts';
import { activateBaselineAgentPrompts, seedPromptsFromDisk } from '../promptreg/registry.ts';
import { ulid } from '../shared/ids.ts';
import { emitEvent } from '../shared/events.ts';
import { notify } from '../shared/notify.ts';
import { selectAdapter } from '../adapters/select.ts';
import { MockAdapter } from '../adapters/mock.ts';
import { runCliCanary } from '../adapters/claude-cli.ts';
import { claimNextPlanningObjective, claimNextTask } from './claims.ts';
import { runExecution, approvalWaits } from './execute.ts';
import { runPlanningForObjective } from '../planning/plan-service.ts';
import { sweepExpiredLeases } from './recovery.ts';
import { runAutopilotSweep } from './autopilot.ts';

const paths = loadPaths();
const cfg = loadSystemConfig();
const db = openDb(paths.dbPath, paths.migrationsDir);
seedOrgAndAgents(db);
seedPromptsFromDisk(db, paths.promptsDir);
activateBaselineAgentPrompts(db, cfg.orgId);

const workerId = ulid('wrk');
let shuttingDown = false;
let activeBranches = 0;
// Leases are extended ONLY for work whose branch is actually in flight.
// A blanket claimed_by/worker_id match would keep renewing the lease of a
// branch that crashed, deadlocking that objective/task until process restart.
const activeTaskIds = new Set<string>();
const activePlanningIds = new Set<string>();

async function main(): Promise<void> {
  let selection = selectAdapter();
  let degradedToMock = false;
  if (selection.name === 'claude-cli') {
    const canary = await runCliCanary(paths.varDir);
    if (!canary.ok) {
      console.error(`[worker] CLI canary FAILED — refusing the claude-cli adapter: ${canary.detail}`);
      degradedToMock = true;
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
  // The workers row records the adapter this process ACTUALLY runs, so
  // /api/health reports the executing worker's truth, not the API server's
  // own environment probe (systemd PATH differences made those diverge).
  db.run(
    `INSERT INTO workers (id, pid, hostname, started_at, last_heartbeat_at, status, adapter, adapter_reason)
     VALUES (?, ?, ?, ?, ?, 'online', ?, ?)`,
    workerId, process.pid, hostname(), now, now, selection.name, selection.reason,
  );
  emitEvent(db, { type: 'worker.online', orgId: cfg.orgId, payload: { workerId, adapter: selection.name, reason: selection.reason } });
  if (degradedToMock) {
    // A worker silently degrading to placeholder output is the worst honesty
    // failure in the system — page the owner, loudly.
    notify(db, cfg.orgId, {
      kind: 'system_degraded', priority: 'critical',
      title: 'Worker is running WITHOUT a real model (mock fallback)',
      body: `${selection.reason}. Tasks will not produce real work until this is fixed (check claude CLI login/PATH for the worker service).`,
      payload: { workerId },
    });
  }

  sweepExpiredLeases(db, cfg);

  // Heartbeat: worker row + lease extension ONLY for branches still in
  // flight (activeTaskIds/activePlanningIds). A crashed branch's lease must
  // be allowed to expire so the sweeper can recover its work.
  const heartbeat = setInterval(() => {
    const ts = Date.now();
    try {
      db.run('UPDATE workers SET last_heartbeat_at = ? WHERE id = ?', ts, workerId);
      if (activeTaskIds.size > 0) {
        const ids = [...activeTaskIds];
        const marks = ids.map(() => '?').join(',');
        db.run(`UPDATE tasks SET lease_expires_at = ? WHERE claimed_by = ? AND id IN (${marks}) AND status IN ('running','waiting_for_tool','waiting_for_approval','verifying')`,
          ts + cfg.leaseMs, workerId, ...ids);
        db.run(`UPDATE executions SET lease_expires_at = ? WHERE worker_id = ? AND task_id IN (${marks}) AND status IN ('running','waiting_for_tool','waiting_for_approval','verifying')`,
          ts + cfg.leaseMs, workerId, ...ids);
      }
      if (activePlanningIds.size > 0) {
        const ids = [...activePlanningIds];
        db.run(`UPDATE objectives SET lease_expires_at = ? WHERE claimed_by = ? AND id IN (${ids.map(() => '?').join(',')}) AND status = 'planning'`,
          ts + cfg.leaseMs * 5, workerId, ...ids);
      }
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
    try {
      runAutopilotSweep(db, cfg);
    } catch (err) {
      console.error('[worker] autopilot sweep failed:', err);
    }
  }, cfg.sweepMs);
  try { runAutopilotSweep(db, cfg); } catch { /* first sweep retries */ }

  const launch = (fn: () => Promise<void>, cleanup: () => void): void => {
    activeBranches++;
    fn()
      .catch((err) => console.error('[worker] branch crashed:', err))
      .finally(() => {
        activeBranches--;
        cleanup();
      });
  };

  // Main claim loop. Branches parked in an owner-approval wait do not count
  // against concurrency — three pending approvals must not freeze the whole
  // company for the approval timeout.
  while (!shuttingDown) {
    let claimed = false;
    if (activeBranches - approvalWaits.count < cfg.maxConcurrentBranches) {
      try {
        const objective = claimNextPlanningObjective(db, cfg, workerId);
        if (objective) {
          claimed = true;
          console.log(`[worker] planning objective ${objective.id}: ${objective.title}`);
          activePlanningIds.add(objective.id);
          launch(async () => {
            const outcome = await runPlanningForObjective(db, adapter, objective.id, workerId);
            console.log(`[worker] planning ${objective.id} -> ${outcome.status}`);
          }, () => activePlanningIds.delete(objective.id));
        } else {
          const task = claimNextTask(db, cfg, workerId);
          if (task) {
            claimed = true;
            console.log(`[worker] executing task ${task.id} (${task.agent_key}: ${task.title}) attempt ${task.attempt_count}`);
            activeTaskIds.add(task.id);
            launch(async () => {
              const outcome = await runExecution(db, cfg, paths, adapter, task, workerId);
              console.log(`[worker] task ${task.id} -> ${outcome}`);
            }, () => activeTaskIds.delete(task.id));
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
