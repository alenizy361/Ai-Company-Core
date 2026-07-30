// The single enforcement point for every AT-SPI accessibility-tree action —
// mirrors ../dispatch.ts's SHAPE exactly (kill-switch first, schema
// validate, audit-first, execute, audit-result) but drops the
// catastrophic-command/curated-app gate entirely: every AT-SPI action is a
// structured find/click/set_text against a matched accessible widget, never
// a free-text command or URL (see ./policy.ts), so schema validation IS the
// full gate — the kill switch (SAME lock file the desktop and browser
// bridges share) is the safety net. AT-SPI has no "page" concept to fall
// back on for debugging a failure the way the browser bridge does, so a
// failed click/set_text/wait_for best-effort captures a WHOLE-SCREEN
// screenshot via the desktop bridge's own backend instead.
import { mkdirSync } from 'node:fs';
import type { Db } from '../../shared/db.ts';
import type { SystemConfig, Paths } from '../../shared/config.ts';
import type { ToolResult } from '../../tools/types.ts';
import { ulid } from '../../shared/ids.ts';
import { emitEvent } from '../../shared/events.ts';
import { storeArtifact } from '../../tools/impl/artifacts.ts';
import { validate, type SchemaNode } from '../../shared/jsonschema.ts';
import { isKilled } from '../kill-switch.ts';
import type { AtspiPolicy } from './policy.ts';
import type { AtspiBackend } from './backend.ts';

export type AtspiActionName = 'list_apps' | 'find' | 'click' | 'set_text' | 'get_text' | 'wait_for';

const ACTION_SCHEMAS: Record<AtspiActionName, SchemaNode> = {
  list_apps: { type: 'object', additionalProperties: false },
  find: {
    type: 'object',
    properties: { app: { type: 'string' }, role: { type: 'string' }, name_pattern: { type: 'string' } },
    additionalProperties: false,
  },
  click: {
    type: 'object',
    properties: { app: { type: 'string' }, role: { type: 'string' }, name_pattern: { type: 'string', minLength: 1, maxLength: 500 } },
    required: ['name_pattern'], additionalProperties: false,
  },
  set_text: {
    type: 'object',
    properties: {
      app: { type: 'string' }, role: { type: 'string' },
      name_pattern: { type: 'string', minLength: 1, maxLength: 500 }, text: { type: 'string', maxLength: 20000 },
    },
    required: ['name_pattern', 'text'], additionalProperties: false,
  },
  get_text: {
    type: 'object',
    properties: { app: { type: 'string' }, role: { type: 'string' }, name_pattern: { type: 'string', minLength: 1, maxLength: 500 } },
    required: ['name_pattern'], additionalProperties: false,
  },
  wait_for: {
    type: 'object',
    properties: {
      app: { type: 'string' }, role: { type: 'string' },
      name_pattern: { type: 'string', minLength: 1, maxLength: 500 }, timeout_ms: { type: 'integer', minimum: 100, maximum: 30000 },
    },
    required: ['name_pattern'], additionalProperties: false,
  },
};

export interface AtspiActionCtx {
  db: Db;
  cfg: SystemConfig;
  paths: Paths;
  orgId: string;
  conversationId: string | null;
  agentKey: string;
  artifactsDir: string;
  turnIndex?: number;
}

// SystemConfig wiring for the action timeout comes in a later task (same
// note as the browser bridge's dispatch.ts) — hardcoded here for now.
const ATSPI_ACTION_TIMEOUT_MS = 10000;

// list_apps/find are read-only lookups and get_text failing means the
// widget itself couldn't be read — a whole-screen shot adds nothing for
// those. click/set_text/wait_for fail when the UI didn't do what was
// expected, which is exactly when a screenshot gives the caller context.
const SCREENSHOT_ON_FAILURE: ReadonlySet<AtspiActionName> = new Set(['click', 'set_text', 'wait_for']);

function recordCall(ctx: AtspiActionCtx, tool: string, argsJson: string, decision: string, status: string, denialReason?: string): string {
  const id = ulid('tc');
  ctx.db.run(
    `INSERT INTO tool_calls (id, execution_id, task_id, conversation_id, agent_key, turn_index, tool, args_json, decision, denial_reason, status, started_at)
     VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, ctx.conversationId, ctx.agentKey, ctx.turnIndex ?? 0, tool, argsJson, decision, denialReason ?? null, status, Date.now(),
  );
  return id;
}

function finishCall(ctx: AtspiActionCtx, toolCallId: string, status: string, resultSummary: string, resultArtifactId: string | null): void {
  ctx.db.run(
    `UPDATE tool_calls SET status = ?, result_summary = ?, result_artifact_id = ?, finished_at = ? WHERE id = ?`,
    status, resultSummary.slice(0, 2000), resultArtifactId, Date.now(), toolCallId,
  );
}

function deny(ctx: AtspiActionCtx, tool: string, argsJson: string, reason: string): ToolResult {
  const toolCallId = recordCall(ctx, tool, argsJson, 'denied', 'denied', reason);
  emitEvent(ctx.db, {
    type: 'atspi.action.denied', orgId: ctx.orgId, agentKey: ctx.agentKey,
    payload: { toolCallId, tool, reason },
  });
  return { ok: false, error: `DENIED: ${reason}` };
}

export async function dispatchAtspiAction(
  ctx: AtspiActionCtx, policy: AtspiPolicy, backend: AtspiBackend, actionName: string, rawArgs: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = `atspi_${actionName}`;
  const args = { ...rawArgs };
  const argsJson = JSON.stringify(args).slice(0, 20000);

  const schema = ACTION_SCHEMAS[actionName as AtspiActionName];
  if (!schema) return deny(ctx, tool, argsJson, `unknown atspi action "${actionName}"`);

  if (isKilled(ctx.paths)) {
    return deny(ctx, tool, argsJson, 'kill switch engaged — desktop control is stopped until POST /api/desktop-bridge/resume');
  }

  const schemaErrors = validate(schema, args);
  if (schemaErrors.length > 0) {
    return deny(ctx, tool, argsJson, `invalid arguments: ${schemaErrors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  }

  const toolCallId = recordCall(ctx, tool, argsJson, 'allowed', 'running');
  emitEvent(ctx.db, { type: 'atspi.action.started', orgId: ctx.orgId, agentKey: ctx.agentKey, payload: { toolCallId, tool } });

  let result: ToolResult;
  try {
    result = await Promise.race([
      runAction(backend, actionName as AtspiActionName, args),
      new Promise<ToolResult>((_, reject) =>
        setTimeout(() => reject(new Error(`atspi action timed out after ${ATSPI_ACTION_TIMEOUT_MS}ms`)), ATSPI_ACTION_TIMEOUT_MS).unref(),
      ),
    ]);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!result.ok && SCREENSHOT_ON_FAILURE.has(actionName as AtspiActionName)) {
    result = await attachFailureScreenshot(ctx, result);
  }

  finishCall(ctx, toolCallId, result.ok ? 'succeeded' : 'failed', result.error ?? JSON.stringify(result.data ?? {}), (result.data?.artifactId as string) ?? null);
  emitEvent(ctx.db, {
    type: result.ok ? 'atspi.action.succeeded' : 'atspi.action.failed',
    orgId: ctx.orgId, agentKey: ctx.agentKey,
    payload: { toolCallId, tool, ok: result.ok, error: result.error ?? null },
  });
  return result;
}

/**
 * Best-effort only — a screenshot failure must never mask the original
 * AT-SPI error the caller actually needs to see, so every failure mode here
 * (backend not ready, screenshot throws, artifact store throws) just falls
 * back to returning the original result untouched.
 */
async function attachFailureScreenshot(ctx: AtspiActionCtx, result: ToolResult): Promise<ToolResult> {
  try {
    const { resolveBackend } = await import('../backend.ts');
    const resolved = await resolveBackend();
    if (!resolved.ready) return result;
    const shot = await resolved.backend.screenshot();
    mkdirSync(ctx.artifactsDir, { recursive: true });
    const stored = storeArtifact(
      { db: ctx.db, artifactsDir: ctx.artifactsDir, orgId: ctx.orgId },
      { taskId: null, executionId: null, agentKey: ctx.agentKey, name: `atspi-failure-${Date.now()}.png.b64`, kind: 'atspi-failure-screenshot', content: shot.base64Png },
    );
    return { ...result, data: { ...(result.data ?? {}), screenshotArtifactId: stored.id } };
  } catch {
    return result;
  }
}

async function runAction(backend: AtspiBackend, actionName: AtspiActionName, args: Record<string, unknown>): Promise<ToolResult> {
  switch (actionName) {
    case 'list_apps':
      return { ok: true, data: { apps: await backend.listApps() } };
    case 'find':
      return {
        ok: true,
        data: {
          matches: await backend.find(
            args.app ? String(args.app) : undefined, args.role ? String(args.role) : undefined, args.name_pattern ? String(args.name_pattern) : undefined,
          ),
        },
      };
    case 'click':
      await backend.click(args.app ? String(args.app) : undefined, args.role ? String(args.role) : undefined, String(args.name_pattern));
      return { ok: true, data: {} };
    case 'set_text':
      await backend.setText(args.app ? String(args.app) : undefined, args.role ? String(args.role) : undefined, String(args.name_pattern), String(args.text));
      return { ok: true, data: {} };
    case 'get_text': {
      const text = await backend.getText(args.app ? String(args.app) : undefined, args.role ? String(args.role) : undefined, String(args.name_pattern));
      return { ok: true, data: { text } };
    }
    case 'wait_for': {
      const found = await backend.waitFor(
        args.app ? String(args.app) : undefined, args.role ? String(args.role) : undefined, String(args.name_pattern),
        args.timeout_ms ? Number(args.timeout_ms) : ATSPI_ACTION_TIMEOUT_MS,
      );
      return { ok: true, data: { found } };
    }
    default:
      return { ok: false, error: `unhandled action "${actionName satisfies never}"` };
  }
}
