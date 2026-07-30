// The single enforcement point for every browser action — mirrors
// ../dispatch.ts's SHAPE exactly (kill-switch first, schema validation,
// audit-first record/finish, honest timeout) but acts on page semantics
// (CSS selectors, tab ids) instead of raw screen coordinates. This is a
// PARALLEL automation layer, not a replacement: the owner's same
// full-permission stance applies here too — no per-action approval gate,
// the safety net is the kill switch (SHARED with the desktop bridge — one
// switch stops ALL automation, browser included) plus policy.ts's URL
// denylist, checked only for navigate (the only action that takes a
// free-form destination).
import { mkdirSync } from 'node:fs';
import type { Db } from '../../shared/db.ts';
import type { SystemConfig, Paths } from '../../shared/config.ts';
import type { ToolResult } from '../../tools/types.ts';
import { ulid } from '../../shared/ids.ts';
import { emitEvent } from '../../shared/events.ts';
import { storeArtifact } from '../../tools/impl/artifacts.ts';
import { validate, type SchemaNode } from '../../shared/jsonschema.ts';
import { isKilled } from '../kill-switch.ts';
import { isNavigationDenied, type BrowserPolicy } from './policy.ts';
import type { BrowserBackend } from './backend.ts';

export type BrowserActionName =
  | 'navigate' | 'click' | 'fill' | 'fill_form' | 'get_text' | 'extract' | 'wait_for'
  | 'screenshot' | 'list_tabs' | 'new_tab' | 'switch_tab' | 'close_tab';

const ACTION_SCHEMAS: Record<BrowserActionName, SchemaNode> = {
  navigate: {
    type: 'object',
    properties: { url: { type: 'string', minLength: 1, maxLength: 4000 }, tab_id: { type: 'string' } },
    required: ['url'], additionalProperties: false,
  },
  click: {
    type: 'object',
    properties: { selector: { type: 'string', minLength: 1, maxLength: 1000 }, tab_id: { type: 'string' } },
    required: ['selector'], additionalProperties: false,
  },
  fill: {
    type: 'object',
    properties: { selector: { type: 'string', minLength: 1, maxLength: 1000 }, value: { type: 'string', maxLength: 20000 }, tab_id: { type: 'string' } },
    required: ['selector', 'value'], additionalProperties: false,
  },
  fill_form: {
    type: 'object',
    properties: {
      fields: {
        type: 'array', minItems: 1, maxItems: 50,
        items: {
          type: 'object',
          properties: { selector: { type: 'string', minLength: 1 }, value: { type: 'string' } },
          required: ['selector', 'value'], additionalProperties: false,
        },
      },
      submit_selector: { type: 'string' }, tab_id: { type: 'string' },
    },
    required: ['fields'], additionalProperties: false,
  },
  get_text: {
    type: 'object',
    properties: { selector: { type: 'string', minLength: 1, maxLength: 1000 }, tab_id: { type: 'string' } },
    required: ['selector'], additionalProperties: false,
  },
  // selectors is a free-form name->CSS-selector map — a full nested schema
  // isn't practical with this validator, so only the top-level shape is
  // checked here; individual entries are validated as strings in runAction().
  extract: {
    type: 'object',
    properties: { selectors: { type: 'object' }, tab_id: { type: 'string' } },
    required: ['selectors'], additionalProperties: false,
  },
  wait_for: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['selector_visible', 'selector_hidden', 'selector_attached', 'load_state', 'url_matches'] },
      selector: { type: 'string' }, pattern: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 100, maximum: 60000 },
      tab_id: { type: 'string' },
    },
    required: ['kind'], additionalProperties: false,
  },
  screenshot: { type: 'object', properties: { tab_id: { type: 'string' } }, additionalProperties: false },
  list_tabs: { type: 'object', additionalProperties: false },
  new_tab: { type: 'object', properties: { url: { type: 'string', maxLength: 4000 } }, additionalProperties: false },
  switch_tab: { type: 'object', properties: { tab_id: { type: 'string', minLength: 1 } }, required: ['tab_id'], additionalProperties: false },
  close_tab: { type: 'object', properties: { tab_id: { type: 'string', minLength: 1 } }, required: ['tab_id'], additionalProperties: false },
};

export interface BrowserActionCtx {
  db: Db;
  cfg: SystemConfig;
  paths: Paths;
  orgId: string;
  conversationId: string | null;
  agentKey: string;
  artifactsDir: string;
  turnIndex?: number;
}

// Wall-clock cap on a single browser action before it's treated as failed.
// NOT yet on SystemConfig (a later task adds browserActionTimeoutMs there,
// mirroring desktopActionTimeoutMs) — a local constant for now.
const BROWSER_ACTION_TIMEOUT_MS = 20000;

// Actions where a failure screenshot is meaningful (the page state at the
// moment of failure helps diagnose it) — list_tabs/get_text/extract/new_tab/
// close_tab/switch_tab don't render page content a screenshot would explain.
const SCREENSHOT_ON_FAILURE_ACTIONS = new Set<BrowserActionName>(['navigate', 'click', 'fill', 'fill_form', 'wait_for']);

function recordCall(ctx: BrowserActionCtx, tool: string, argsJson: string, decision: string, status: string, denialReason?: string): string {
  const id = ulid('tc');
  ctx.db.run(
    `INSERT INTO tool_calls (id, execution_id, task_id, conversation_id, agent_key, turn_index, tool, args_json, decision, denial_reason, status, started_at)
     VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, ctx.conversationId, ctx.agentKey, ctx.turnIndex ?? 0, tool, argsJson, decision, denialReason ?? null, status, Date.now(),
  );
  return id;
}

function finishCall(ctx: BrowserActionCtx, toolCallId: string, status: string, resultSummary: string, resultArtifactId: string | null): void {
  ctx.db.run(
    `UPDATE tool_calls SET status = ?, result_summary = ?, result_artifact_id = ?, finished_at = ? WHERE id = ?`,
    status, resultSummary.slice(0, 2000), resultArtifactId, Date.now(), toolCallId,
  );
}

function deny(ctx: BrowserActionCtx, tool: string, argsJson: string, reason: string): ToolResult {
  const toolCallId = recordCall(ctx, tool, argsJson, 'denied', 'denied', reason);
  emitEvent(ctx.db, {
    type: 'browser.action.denied', orgId: ctx.orgId, agentKey: ctx.agentKey,
    payload: { toolCallId, tool, reason },
  });
  return { ok: false, error: `DENIED: ${reason}` };
}

export async function dispatchBrowserAction(
  ctx: BrowserActionCtx, policy: BrowserPolicy, backend: BrowserBackend, actionName: string, rawArgs: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = `browser_${actionName}`;
  const args = { ...rawArgs };
  const argsJson = JSON.stringify(args).slice(0, 20000);

  const schema = ACTION_SCHEMAS[actionName as BrowserActionName];
  if (!schema) return deny(ctx, tool, argsJson, `unknown browser action "${actionName}"`);

  if (isKilled(ctx.paths)) {
    return deny(ctx, tool, argsJson, 'kill switch engaged — desktop control is stopped until POST /api/desktop-bridge/resume');
  }

  const schemaErrors = validate(schema, args);
  if (schemaErrors.length > 0) {
    return deny(ctx, tool, argsJson, `invalid arguments: ${schemaErrors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  }

  if (actionName === 'navigate') {
    const check = isNavigationDenied(policy, String(args.url));
    if (check.denied) return deny(ctx, tool, argsJson, `navigation blocked — ${check.reason}`);
  }

  const toolCallId = recordCall(ctx, tool, argsJson, 'allowed', 'running');
  emitEvent(ctx.db, { type: 'browser.action.started', orgId: ctx.orgId, agentKey: ctx.agentKey, payload: { toolCallId, tool } });

  let result: ToolResult;
  try {
    result = await Promise.race([
      runAction(backend, actionName as BrowserActionName, args),
      new Promise<ToolResult>((_, reject) =>
        setTimeout(() => reject(new Error(`browser action timed out after ${BROWSER_ACTION_TIMEOUT_MS}ms`)), BROWSER_ACTION_TIMEOUT_MS).unref(),
      ),
    ]);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!result.ok && SCREENSHOT_ON_FAILURE_ACTIONS.has(actionName as BrowserActionName)) {
    // Best-effort — a screenshot failure must never mask the original error.
    try {
      const shot = await backend.screenshotPage(args.tab_id ? String(args.tab_id) : undefined);
      mkdirSync(ctx.artifactsDir, { recursive: true });
      const stored = storeArtifact(
        { db: ctx.db, artifactsDir: ctx.artifactsDir, orgId: ctx.orgId },
        { taskId: null, executionId: null, agentKey: ctx.agentKey, name: `browser-failure-${Date.now()}.png.b64`, kind: 'browser-failure-screenshot', content: shot.base64Png },
      );
      result = { ...result, data: { ...(result.data ?? {}), screenshotArtifactId: stored.id } };
    } catch {
      /* screenshot-on-failure is a diagnostic nicety, not load-bearing */
    }
  }

  finishCall(ctx, toolCallId, result.ok ? 'succeeded' : 'failed', result.error ?? JSON.stringify(result.data ?? {}), (result.data?.artifactId as string) ?? null);
  emitEvent(ctx.db, {
    type: result.ok ? 'browser.action.succeeded' : 'browser.action.failed',
    orgId: ctx.orgId, agentKey: ctx.agentKey,
    payload: { toolCallId, tool, ok: result.ok, error: result.error ?? null },
  });
  return result;
}

async function runAction(backend: BrowserBackend, actionName: BrowserActionName, args: Record<string, unknown>): Promise<ToolResult> {
  const tabId = args.tab_id ? String(args.tab_id) : undefined;
  switch (actionName) {
    case 'navigate': {
      const tab = await backend.navigate(String(args.url), tabId);
      return { ok: true, data: { tabId: tab.tabId, url: tab.url, title: tab.title } };
    }
    case 'click':
      await backend.click(String(args.selector), tabId);
      return { ok: true, data: {} };
    case 'fill':
      await backend.fill(String(args.selector), String(args.value), tabId);
      return { ok: true, data: {} };
    case 'fill_form': {
      const fields = args.fields as { selector: string; value: string }[];
      await backend.fillForm(fields, args.submit_selector ? String(args.submit_selector) : undefined, tabId);
      return { ok: true, data: {} };
    }
    case 'get_text': {
      const text = await backend.getText(String(args.selector), tabId);
      return { ok: true, data: { text } };
    }
    case 'extract': {
      const rawSelectors = args.selectors as Record<string, unknown>;
      const selectors: Record<string, string> = {};
      for (const [name, sel] of Object.entries(rawSelectors)) {
        if (typeof sel !== 'string') return { ok: false, error: `extract selectors.${name} must be a string, got ${typeof sel}` };
        selectors[name] = sel;
      }
      const extracted = await backend.extract(selectors, tabId);
      return { ok: true, data: { ...extracted } };
    }
    case 'wait_for':
      await backend.waitFor(
        {
          kind: args.kind as 'selector_visible' | 'selector_hidden' | 'selector_attached' | 'load_state' | 'url_matches',
          selector: args.selector ? String(args.selector) : undefined,
          pattern: args.pattern ? String(args.pattern) : undefined,
          timeoutMs: args.timeout_ms ? Number(args.timeout_ms) : undefined,
        },
        tabId,
      );
      return { ok: true, data: {} };
    case 'screenshot': {
      const shot = await backend.screenshotPage(tabId);
      return { ok: true, data: { base64Png: shot.base64Png, width: shot.width, height: shot.height } };
    }
    case 'list_tabs': {
      const tabs = await backend.listTabs();
      return { ok: true, data: { tabs } };
    }
    case 'new_tab': {
      const tab = await backend.newTab(args.url ? String(args.url) : undefined);
      return { ok: true, data: { tabId: tab.tabId } };
    }
    case 'switch_tab': {
      // No dedicated backend method — subsequent actions already take an
      // explicit tab_id, so "switching" is really just proving the target
      // tab exists and handing its current info back to the caller.
      const tabs = await backend.listTabs();
      const target = String(args.tab_id);
      const tab = tabs.find((t) => t.tabId === target);
      if (!tab) return { ok: false, error: `no such tab "${target}"` };
      return { ok: true, data: { ...tab } };
    }
    case 'close_tab':
      await backend.closeTab(String(args.tab_id));
      return { ok: true, data: {} };
    default:
      return { ok: false, error: `unhandled action "${actionName satisfies never}"` };
  }
}
