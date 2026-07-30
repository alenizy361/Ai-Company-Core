// Pure DB access for saved_workflows — CRUD only, no dispatch/replay logic
// (that's replay.ts). Mirrors read_artifact/write_artifact's DB-direct
// pattern: this is metadata the API server process can read/write itself,
// no daemon round trip needed (only actually RUNNING a workflow needs the
// daemon, since only it holds live browser/AT-SPI backend instances).
import type { Db } from '../../shared/db.ts';
import { ulid } from '../../shared/ids.ts';

export type WorkflowKind = 'browser' | 'atspi';

export interface WorkflowStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface SavedWorkflowRow {
  id: string;
  org_id: string;
  name: string;
  kind: WorkflowKind;
  signature_json: string;
  steps_json: string;
  created_by_agent_key: string | null;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  run_count: number;
  last_result_json: string | null;
}

export interface SaveWorkflowInput {
  orgId: string;
  name: string;
  kind: WorkflowKind;
  signature: Record<string, unknown>;
  steps: WorkflowStep[];
  createdByAgentKey?: string;
}

/**
 * A saved workflow may only contain steps for its own kind's tool family
 * (browser_* for kind:'browser', atspi_* for kind:'atspi') — never a raw
 * desktop_click(x,y) step. Absolute screen coordinates are exactly the
 * fragile state this whole feature exists to move away from.
 */
export function validateWorkflowSteps(kind: WorkflowKind, steps: WorkflowStep[]): { ok: true } | { ok: false; error: string } {
  if (steps.length === 0) return { ok: false, error: 'a workflow needs at least one step' };
  const prefix = `${kind}_`;
  for (const [i, step] of steps.entries()) {
    if (typeof step.tool !== 'string' || !step.tool.startsWith(prefix)) {
      return { ok: false, error: `step ${i}: tool "${step.tool}" is not a ${prefix}* tool — saved workflows may not contain raw coordinate-based (desktop_*) steps` };
    }
  }
  return { ok: true };
}

export function saveWorkflow(db: Db, input: SaveWorkflowInput): { id: string } {
  const validation = validateWorkflowSteps(input.kind, input.steps);
  if (!validation.ok) throw new Error(validation.error);

  const existing = db.get<{ id: string }>(
    `SELECT id FROM saved_workflows WHERE org_id = ? AND name = ?`, input.orgId, input.name,
  );
  const now = Date.now();
  if (existing) {
    db.run(
      `UPDATE saved_workflows SET kind = ?, signature_json = ?, steps_json = ?, updated_at = ? WHERE id = ?`,
      input.kind, JSON.stringify(input.signature), JSON.stringify(input.steps), now, existing.id,
    );
    return { id: existing.id };
  }
  const id = ulid('wf');
  db.run(
    `INSERT INTO saved_workflows (id, org_id, name, kind, signature_json, steps_json, created_by_agent_key, created_at, updated_at, run_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    id, input.orgId, input.name, input.kind, JSON.stringify(input.signature), JSON.stringify(input.steps),
    input.createdByAgentKey ?? null, now, now,
  );
  return { id };
}

export function listWorkflows(db: Db, orgId: string, nameFilter?: string): SavedWorkflowRow[] {
  return nameFilter
    ? db.all<SavedWorkflowRow>(
        `SELECT * FROM saved_workflows WHERE org_id = ? AND name LIKE ? ORDER BY updated_at DESC`,
        orgId, `%${nameFilter}%`,
      )
    : db.all<SavedWorkflowRow>(`SELECT * FROM saved_workflows WHERE org_id = ? ORDER BY updated_at DESC`, orgId);
}

export function getWorkflow(db: Db, orgId: string, name: string): SavedWorkflowRow | undefined {
  return db.get<SavedWorkflowRow>(`SELECT * FROM saved_workflows WHERE org_id = ? AND name = ?`, orgId, name);
}

export function recordWorkflowRun(db: Db, id: string, resultJson: string): void {
  db.run(
    `UPDATE saved_workflows SET last_run_at = ?, run_count = run_count + 1, last_result_json = ? WHERE id = ?`,
    Date.now(), resultJson.slice(0, 4000), id,
  );
}
