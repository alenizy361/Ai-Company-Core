// MCP tool server exposing browser automation to the parent SIRA session
// only (see src/sira/session.ts) — mirrors desktop-bridge-tools.ts's shape
// exactly, but each handler goes through the desktop-bridge daemon's
// /browser/* routes (src/desktop-bridge/browser/) instead of /actions/*.
// Semantic, selector-based control — prefer these over desktop_* coordinate
// tools whenever the target is a web page (see the Automation method
// preference section wired into the parent session's prompt).
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SystemConfig } from '../shared/config.ts';
import { callBrowserAction } from '../desktop-bridge/browser/client.ts';
import { toCallToolResult } from './desktop-bridge-tools.ts';
import type { ToolResult } from './types.ts';

export interface BrowserToolServerDeps {
  cfg: SystemConfig;
  agentKey: string;
  conversationId: string;
}

export interface BrowserToolServer {
  server: ReturnType<typeof createSdkMcpServer>;
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

const WAIT_KINDS = ['selector_visible', 'selector_hidden', 'selector_attached', 'load_state', 'url_matches'] as const;

export function buildBrowserToolServer(deps: BrowserToolServerDeps): BrowserToolServer {
  const dispatch = (action: string, args: Record<string, unknown>): Promise<ToolResult> =>
    callBrowserAction(deps.cfg, { tool: action, args, agentKey: deps.agentKey, conversationId: deps.conversationId });
  const callTool = dispatch;
  const run = (action: string, args: Record<string, unknown>): Promise<ReturnType<typeof toCallToolResult>> =>
    dispatch(action, args).then(toCallToolResult);

  const server = createSdkMcpServer({
    name: 'sira-browser',
    tools: [
      tool('browser_navigate', 'Navigate the browser to a URL. Fast and reliable — prefer this over desktop_click for anything reachable by URL. Stays logged into sites across calls (persistent session).',
        { url: z.string().min(1).max(4000), tab_id: z.string().optional() }, (a) => run('navigate', a)),
      tool('browser_click', 'Click an element on the current page by CSS selector or visible text. Prefer this over desktop_click for anything inside a browser tab — no screenshot/coordinates needed.',
        { selector: z.string().min(1).max(1000), tab_id: z.string().optional() }, (a) => run('click', a)),
      tool('browser_fill', 'Type a value into a form field by CSS selector.',
        { selector: z.string().min(1).max(1000), value: z.string().max(20000), tab_id: z.string().optional() }, (a) => run('fill', a)),
      tool('browser_fill_form', 'Fill multiple form fields and optionally submit, all in one call — prefer this over N separate browser_fill calls for a multi-field form.',
        {
          fields: z.array(z.object({ selector: z.string().min(1), value: z.string() })).min(1).max(50),
          submit_selector: z.string().optional(), tab_id: z.string().optional(),
        }, (a) => run('fill_form', a)),
      tool('browser_get_text', 'Read the visible text of an element by CSS selector.',
        { selector: z.string().min(1).max(1000), tab_id: z.string().optional() }, (a) => run('get_text', a)),
      tool('browser_extract', 'Read the text of several elements in one call — pass a map of name -> CSS selector, get back name -> text.',
        { selectors: z.record(z.string(), z.string()), tab_id: z.string().optional() }, (a) => run('extract', a)),
      tool('browser_wait_for', 'Wait for a real page condition (element visible/hidden/attached, page load state, or URL match) instead of guessing a fixed delay.',
        {
          kind: z.enum(WAIT_KINDS), selector: z.string().optional(), pattern: z.string().optional(),
          timeout_ms: z.number().int().min(100).max(60000).optional(), tab_id: z.string().optional(),
        }, (a) => run('wait_for', a)),
      tool('browser_screenshot', 'Take a screenshot of the current page (not the whole desktop). Use only to diagnose why something failed — do not screenshot after a successful action.',
        { tab_id: z.string().optional() }, (a) => run('screenshot', a)),
      tool('browser_list_tabs', 'List currently open browser tabs.', {}, () => run('list_tabs', {})),
      tool('browser_new_tab', 'Open a new browser tab, optionally navigating it to a URL.',
        { url: z.string().max(4000).optional() }, (a) => run('new_tab', a)),
      tool('browser_switch_tab', 'Confirm a tab id exists and get its current URL/title (subsequent tool calls already take tab_id directly, this is for orientation).',
        { tab_id: z.string().min(1) }, (a) => run('switch_tab', a)),
      tool('browser_close_tab', 'Close a browser tab by id.',
        { tab_id: z.string().min(1) }, (a) => run('close_tab', a)),
    ],
  });
  return { server, callTool };
}

export const BROWSER_TOOL_NAMES = [
  'browser_navigate', 'browser_click', 'browser_fill', 'browser_fill_form', 'browser_get_text',
  'browser_extract', 'browser_wait_for', 'browser_screenshot', 'browser_list_tabs',
  'browser_new_tab', 'browser_switch_tab', 'browser_close_tab',
];
