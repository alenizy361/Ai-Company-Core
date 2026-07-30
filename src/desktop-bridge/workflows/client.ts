// API-server-side HTTP client to the daemon's POST /workflows/:name/run —
// mirrors ../client.ts's callDesktopAction() shape. workflow_save/list stay
// DB-direct (see ../../tools/workflow-tools.ts) since they're pure metadata;
// only actually RUNNING a workflow needs the daemon, since only it holds
// live browser/AT-SPI backend instances.
import type { SystemConfig } from '../../shared/config.ts';
import type { WorkflowRunResult } from './replay.ts';

export interface WorkflowRunRequest {
  name: string;
  params: Record<string, string>;
  agentKey: string;
  conversationId: string | null;
}

export async function callWorkflowRun(cfg: SystemConfig, req: WorkflowRunRequest): Promise<WorkflowRunResult> {
  try {
    const res = await fetch(`${cfg.desktopBridgeUrl}/workflows/${encodeURIComponent(req.name)}/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.DESKTOP_BRIDGE_TOKEN ? { authorization: `Bearer ${process.env.DESKTOP_BRIDGE_TOKEN}` } : {}),
      },
      body: JSON.stringify({ params: req.params, agentKey: req.agentKey, conversationId: req.conversationId }),
      signal: AbortSignal.timeout(120000), // workflows can run many steps — a generous ceiling, not per-step
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `workflow bridge returned ${res.status}: ${text.slice(0, 300)}`, stepsCompleted: 0, totalSteps: 0, results: [] };
    }
    return await res.json() as WorkflowRunResult;
  } catch (err) {
    return { ok: false, error: `desktop bridge unreachable: ${err instanceof Error ? err.message : String(err)}`, stepsCompleted: 0, totalSteps: 0, results: [] };
  }
}
