// The single enforcement point for every desktop action — deliberately NOT
// a reuse of src/tools/dispatch.ts (no role/path/approval concepts apply to
// a mouse click or a screenshot), but mirroring its SHAPE: one choke point,
// audit-first, deny-list check, execute, audit-result. The owner explicitly
// asked for full permission with no per-action approval gate here — the
// safety net is the kill switch (checked first, unconditionally) and the
// catastrophic-action denylist (checked for open_app/run_command only,
// since those are the only actions that take a free-form string), not a
// confirmation workflow.
import { mkdirSync } from 'node:fs';
import type { Db } from '../shared/db.ts';
import type { SystemConfig, Paths } from '../shared/config.ts';
import type { ToolResult } from '../tools/types.ts';
import { ulid } from '../shared/ids.ts';
import { emitEvent } from '../shared/events.ts';
import { storeArtifact } from '../tools/impl/artifacts.ts';
import { validate, type SchemaNode } from '../shared/jsonschema.ts';
import { isKilled } from './kill-switch.ts';
import { isCatastrophic, resolveCuratedApp, type DesktopPolicy } from './policy.ts';
import type { DesktopBackend } from './backend.ts';

export type DesktopActionName =
  | 'screenshot' | 'click' | 'move_mouse' | 'type' | 'key' | 'scroll' | 'open_app' | 'run_command';

const ACTION_SCHEMAS: Record<DesktopActionName, SchemaNode> = {
  screenshot: { type: 'object', additionalProperties: false },
  click: {
    type: 'object',
    properties: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string' }, clicks: { type: 'integer', minimum: 1, maximum: 10 } },
    required: ['x', 'y'], additionalProperties: false,
  },
  move_mouse: {
    type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false,
  },
  type: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 20000 } }, required: ['text'], additionalProperties: false },
  key: { type: 'object', properties: { key: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['key'], additionalProperties: false },
  scroll: {
    type: 'object',
    properties: { direction: { type: 'string' }, amount: { type: 'integer', minimum: 1, maximum: 50 } },
    required: ['direction'], additionalProperties: false,
  },
  open_app: { type: 'object', properties: { app: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['app'], additionalProperties: false },
  run_command: {
    type: 'object',
    properties: { cmd: { type: 'string', minLength: 1, maxLength: 4000 }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000 } },
    required: ['cmd'], additionalProperties: false,
  },
};

export interface DesktopActionCtx {
  db: Db;
  cfg: SystemConfig;
  paths: Paths;
  orgId: string;
  conversationId: string | null;
  agentKey: string;
  artifactsDir: string;
  turnIndex?: number;
}

function recordCall(ctx: DesktopActionCtx, tool: string, argsJson: string, decision: string, status: string, denialReason?: string): string {
  const id = ulid('tc');
  ctx.db.run(
    `INSERT INTO tool_calls (id, execution_id, task_id, conversation_id, agent_key, turn_index, tool, args_json, decision, denial_reason, status, started_at)
     VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, ctx.conversationId, ctx.agentKey, ctx.turnIndex ?? 0, tool, argsJson, decision, denialReason ?? null, status, Date.now(),
  );
  return id;
}

function finishCall(ctx: DesktopActionCtx, toolCallId: string, status: string, resultSummary: string, resultArtifactId: string | null): void {
  ctx.db.run(
    `UPDATE tool_calls SET status = ?, result_summary = ?, result_artifact_id = ?, finished_at = ? WHERE id = ?`,
    status, resultSummary.slice(0, 2000), resultArtifactId, Date.now(), toolCallId,
  );
}

function deny(ctx: DesktopActionCtx, tool: string, argsJson: string, reason: string): ToolResult {
  const toolCallId = recordCall(ctx, tool, argsJson, 'denied', 'denied', reason);
  emitEvent(ctx.db, {
    type: 'desktop.action.denied', orgId: ctx.orgId, agentKey: ctx.agentKey,
    payload: { toolCallId, tool, reason },
  });
  return { ok: false, error: `DENIED: ${reason}` };
}

export async function dispatchDesktopAction(
  ctx: DesktopActionCtx, policy: DesktopPolicy, backend: DesktopBackend, actionName: string, rawArgs: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = `desktop_${actionName}`;
  const args = { ...rawArgs };
  const argsJson = JSON.stringify(args).slice(0, 20000);

  const schema = ACTION_SCHEMAS[actionName as DesktopActionName];
  if (!schema) return deny(ctx, tool, argsJson, `unknown desktop action "${actionName}"`);

  if (isKilled(ctx.paths)) {
    return deny(ctx, tool, argsJson, 'kill switch engaged — desktop control is stopped until POST /api/desktop-bridge/resume');
  }

  const schemaErrors = validate(schema, args);
  if (schemaErrors.length > 0) {
    return deny(ctx, tool, argsJson, `invalid arguments: ${schemaErrors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  }

  if (actionName === 'run_command') {
    const check = isCatastrophic(policy, String(args.cmd));
    if (check.denied) return deny(ctx, tool, argsJson, `catastrophic command blocked — ${check.reason}`);
  }
  if (actionName === 'open_app') {
    const curated = resolveCuratedApp(policy, String(args.app));
    if (!curated) {
      return deny(ctx, tool, argsJson, `"${String(args.app)}" is not a curated app — add it to config/desktop-bridge.json's curatedApps to allow it`);
    }
  }

  const toolCallId = recordCall(ctx, tool, argsJson, 'allowed', 'running');
  emitEvent(ctx.db, { type: 'desktop.action.started', orgId: ctx.orgId, agentKey: ctx.agentKey, payload: { toolCallId, tool } });

  let result: ToolResult;
  try {
    result = await Promise.race([
      runAction(ctx, backend, policy, actionName as DesktopActionName, args),
      new Promise<ToolResult>((_, reject) =>
        setTimeout(() => reject(new Error(`desktop action timed out after ${ctx.cfg.desktopActionTimeoutMs}ms`)), ctx.cfg.desktopActionTimeoutMs).unref(),
      ),
    ]);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  finishCall(ctx, toolCallId, result.ok ? 'succeeded' : 'failed', result.error ?? JSON.stringify(result.data ?? {}), (result.data?.artifactId as string) ?? null);
  emitEvent(ctx.db, {
    type: result.ok ? 'desktop.action.succeeded' : 'desktop.action.failed',
    orgId: ctx.orgId, agentKey: ctx.agentKey,
    payload: { toolCallId, tool, ok: result.ok, error: result.error ?? null },
  });
  return result;
}

async function runAction(ctx: DesktopActionCtx, backend: DesktopBackend, policy: DesktopPolicy, actionName: DesktopActionName, args: Record<string, unknown>): Promise<ToolResult> {
  switch (actionName) {
    case 'screenshot': {
      const shot = await backend.screenshot();
      mkdirSync(ctx.artifactsDir, { recursive: true });
      const stored = storeArtifact(
        { db: ctx.db, artifactsDir: ctx.artifactsDir, orgId: ctx.orgId },
        { taskId: null, executionId: null, agentKey: ctx.agentKey, name: `screenshot-${Date.now()}.png.b64`, kind: 'screenshot', content: shot.base64Png },
      );
      return { ok: true, data: { base64Png: shot.base64Png, width: shot.width, height: shot.height, artifactId: stored.id } };
    }
    case 'click':
      await backend.click(Number(args.x), Number(args.y), args.button ? String(args.button) : undefined, args.clicks ? Number(args.clicks) : undefined);
      return { ok: true, data: {} };
    case 'move_mouse':
      await backend.moveMouse(Number(args.x), Number(args.y));
      return { ok: true, data: {} };
    case 'type':
      await backend.typeText(String(args.text));
      return { ok: true, data: {} };
    case 'key':
      await backend.keyPress(String(args.key));
      return { ok: true, data: {} };
    case 'scroll':
      await backend.scroll(String(args.direction) as 'up' | 'down' | 'left' | 'right', args.amount ? Number(args.amount) : undefined);
      return { ok: true, data: {} };
    case 'open_app': {
      // Re-resolved here (not just at the earlier gate) so the actual
      // launch target always comes from policy, never the raw model input —
      // the gate only proved a curated entry EXISTS, this reads it for real.
      const curated = resolveCuratedApp(policy, String(args.app));
      if (!curated) return { ok: false, error: `"${String(args.app)}" is not a curated app` };
      await backend.openApp(curated.desktopFile, curated.fallbackBin);
      return { ok: true, data: {} };
    }
    case 'run_command': {
      const res = await backend.runCommand(String(args.cmd), Number(args.timeout_ms ?? ctx.cfg.desktopActionTimeoutMs));
      return { ok: res.exitCode === 0, data: { exit_code: res.exitCode, stdout: res.stdout, stderr: res.stderr } };
    }
    default:
      return { ok: false, error: `unhandled action "${actionName satisfies never}"` };
  }
}
