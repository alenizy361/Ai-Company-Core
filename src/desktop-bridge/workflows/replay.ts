// Replays a saved workflow entirely locally, without a model call per step —
// but each replayed step still goes through the SAME dispatchBrowserAction/
// dispatchAtspiAction enforcement point a live call would, so replay is
// exactly as audited (one tool_calls row per step) as a live sequence.
import type { Db } from '../../shared/db.ts';
import type { ToolResult } from '../../tools/types.ts';
import type { SavedWorkflowRow, WorkflowStep } from './store.ts';
import { recordWorkflowRun } from './store.ts';
import { dispatchBrowserAction, type BrowserActionCtx } from '../browser/dispatch.ts';
import type { BrowserPolicy } from '../browser/policy.ts';
import type { BrowserBackend } from '../browser/backend.ts';
import { dispatchAtspiAction, type AtspiActionCtx } from '../atspi/dispatch.ts';
import type { AtspiPolicy } from '../atspi/policy.ts';
import type { AtspiBackend } from '../atspi/backend.ts';

export interface WorkflowRunResult {
  ok: boolean;
  error?: string;
  stepsCompleted: number;
  totalSteps: number;
  results: ToolResult[];
}

/**
 * Plain string substitution, no expression language — same "no eval"
 * discipline run_command/commandAllowed already enforce elsewhere. Applied
 * recursively so nested structures (e.g. fill_form's fields array) still
 * get their {{param}} placeholders replaced.
 */
function substituteParams(value: unknown, params: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in params ? params[key] : match));
  }
  if (Array.isArray(value)) return value.map((v) => substituteParams(v, params));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substituteParams(v, params)]));
  }
  return value;
}

function stepAction(kind: 'browser' | 'atspi', step: WorkflowStep): string {
  return step.tool.slice(`${kind}_`.length);
}

async function checkSignature(
  workflow: SavedWorkflowRow, browserBackend?: BrowserBackend, atspiBackend?: AtspiBackend,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const signature = JSON.parse(workflow.signature_json) as Record<string, unknown>;
  if (workflow.kind === 'browser') {
    if (!browserBackend) return { ok: false, error: 'browser backend unavailable' };
    const pattern = typeof signature.urlPattern === 'string' ? signature.urlPattern : null;
    if (!pattern) return { ok: true }; // no signature to check — proceed
    const tabs = await browserBackend.listTabs();
    const re = new RegExp(pattern);
    if (!tabs.some((t) => re.test(t.url))) {
      return { ok: false, error: `signature mismatch: no open tab matches urlPattern "${pattern}" (open: ${tabs.map((t) => t.url).join(', ') || 'none'})` };
    }
    return { ok: true };
  }
  if (!atspiBackend) return { ok: false, error: 'atspi backend unavailable' };
  const appName = typeof signature.appName === 'string' ? signature.appName : null;
  if (!appName) return { ok: true };
  const apps = await atspiBackend.listApps();
  if (!apps.some((a) => a.name === appName)) {
    return { ok: false, error: `signature mismatch: app "${appName}" is not running (running: ${apps.map((a) => a.name).join(', ') || 'none'})` };
  }
  return { ok: true };
}

export interface ReplayDeps {
  browserActionCtx?: BrowserActionCtx;
  browserPolicy?: BrowserPolicy;
  browserBackend?: BrowserBackend;
  atspiActionCtx?: AtspiActionCtx;
  atspiPolicy?: AtspiPolicy;
  atspiBackend?: AtspiBackend;
}

export async function replayWorkflow(
  db: Db, workflow: SavedWorkflowRow, params: Record<string, string>, deps: ReplayDeps,
): Promise<WorkflowRunResult> {
  const steps = JSON.parse(workflow.steps_json) as WorkflowStep[];

  // Zero steps run on a signature mismatch — the decision goes back to
  // whoever asked for the replay, never a guess at recovery.
  const signatureCheck = await checkSignature(workflow, deps.browserBackend, deps.atspiBackend);
  if (!signatureCheck.ok) {
    const result: WorkflowRunResult = { ok: false, error: signatureCheck.error, stepsCompleted: 0, totalSteps: steps.length, results: [] };
    recordWorkflowRun(db, workflow.id, JSON.stringify(result));
    return result;
  }

  // Non-null assertions below are safe by construction: the caller (the
  // daemon's /workflows/:name/run route) always populates browser* deps for
  // a browser-kind workflow and atspi* deps for an atspi-kind one — kind is
  // fixed at save time (validateWorkflowSteps + a DB CHECK constraint).
  const results: ToolResult[] = [];
  for (const step of steps) {
    const args = substituteParams(step.args, params) as Record<string, unknown>;
    const action = stepAction(workflow.kind, step);
    const result = workflow.kind === 'browser'
      ? await dispatchBrowserAction(deps.browserActionCtx!, deps.browserPolicy!, deps.browserBackend!, action, args)
      : await dispatchAtspiAction(deps.atspiActionCtx!, deps.atspiPolicy!, deps.atspiBackend!, action, args);
    results.push(result);
    if (!result.ok) {
      const failed: WorkflowRunResult = {
        ok: false, error: `step ${results.length - 1} (${step.tool}) failed: ${result.error}`,
        stepsCompleted: results.length - 1, totalSteps: steps.length, results,
      };
      recordWorkflowRun(db, workflow.id, JSON.stringify(failed));
      return failed;
    }
  }

  const success: WorkflowRunResult = { ok: true, stepsCompleted: steps.length, totalSteps: steps.length, results };
  recordWorkflowRun(db, workflow.id, JSON.stringify(success));
  return success;
}
