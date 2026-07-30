// MCP tool server exposing desktop control to the parent SIRA session only
// (see src/sira/session.ts) — mirrors src/tools/sdk-bridge.ts's shape, but
// each handler is a thin HTTP client to the desktop-bridge daemon (a
// SEPARATE OS process — see src/desktop-bridge/) rather than a local
// dispatch call, since only that process has real desktop session access.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import type { SystemConfig } from '../shared/config.ts';
import { callDesktopAction } from '../desktop-bridge/client.ts';
import type { ToolResult } from './types.ts';

/** Exported for direct unit testing — a pure mapping, no reason to only
 *  exercise it indirectly through a live SDK tool call. */
export function toCallToolResult(result: ToolResult): CallToolResult {
  if (result.ok && typeof result.data?.base64Png === 'string') {
    // Real image content block for a screenshot — this is the whole point
    // of the "computer use" pattern: the model needs to actually SEE the
    // screen, not just be told a screenshot was taken.
    const { base64Png, width, height, artifactId, ...rest } = result.data;
    const content: ContentBlock[] = [
      { type: 'image', data: base64Png, mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify({ width, height, artifactId, ...rest }) },
    ];
    return { content, isError: false };
  }
  const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify(result.ok ? (result.data ?? {}) : { error: result.error }) }];
  return { content, isError: !result.ok };
}

export interface DesktopToolServerDeps {
  cfg: SystemConfig;
  agentKey: string;
  conversationId: string;
}

export interface DesktopToolServer {
  server: ReturnType<typeof createSdkMcpServer>;
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

const CLICK_BUTTONS = ['left', 'middle', 'right'] as const;
const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;

export function buildDesktopToolServer(deps: DesktopToolServerDeps): DesktopToolServer {
  const dispatch = (action: string, args: Record<string, unknown>): Promise<ToolResult> =>
    callDesktopAction(deps.cfg, { tool: action, args, agentKey: deps.agentKey, conversationId: deps.conversationId });
  const callTool = dispatch;
  const run = (action: string, args: Record<string, unknown>): Promise<ReturnType<typeof toCallToolResult>> =>
    dispatch(action, args).then(toCallToolResult);

  const server = createSdkMcpServer({
    name: 'sira-desktop',
    tools: [
      tool('desktop_screenshot', 'Take a screenshot of the current desktop screen. Returns the image so you can see what is actually on screen right now.',
        {}, () => run('screenshot', {})),
      tool('desktop_click', 'Click at a screen coordinate. Take a screenshot first if you do not already know the exact coordinates.',
        { x: z.number(), y: z.number(), button: z.enum(CLICK_BUTTONS).optional(), clicks: z.number().int().min(1).max(10).optional() },
        (a) => run('click', a)),
      tool('desktop_move_mouse', 'Move the mouse cursor to a screen coordinate without clicking.',
        { x: z.number(), y: z.number() }, (a) => run('move_mouse', a)),
      tool('desktop_type', 'Type text at the current keyboard focus (wherever the cursor/focus currently is — click a field first if needed).',
        { text: z.string().min(1).max(20000) }, (a) => run('type', a)),
      tool('desktop_key', 'Press a single key or key combination (e.g. "Return", "Escape", "ctrl+c", "alt+Tab").',
        { key: z.string().min(1).max(100) }, (a) => run('key', a)),
      tool('desktop_scroll', 'Scroll the focused window/element.',
        { direction: z.enum(SCROLL_DIRECTIONS), amount: z.number().int().min(1).max(50).optional() }, (a) => run('scroll', a)),
      tool('desktop_open_app', 'Launch a curated desktop application by name (see config/desktop-bridge.json for the allowed list, e.g. "browser", "whatsapp", "mail", "calendar", "files", "terminal").',
        { app: z.string().min(1).max(200) }, (a) => run('open_app', a)),
      tool('desktop_run_command', 'Run a local command on the desktop machine (no shell — no pipes/redirection/substitution). Blocked for catastrophic actions regardless of intent.',
        { cmd: z.string().min(1).max(4000), timeout_ms: z.number().int().min(1000).max(120000).optional() }, (a) => run('run_command', a)),
    ],
  });
  return { server, callTool };
}

export const DESKTOP_TOOL_NAMES = [
  'desktop_screenshot', 'desktop_click', 'desktop_move_mouse', 'desktop_type',
  'desktop_key', 'desktop_scroll', 'desktop_open_app', 'desktop_run_command',
];
