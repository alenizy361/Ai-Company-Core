// MCP tool server exposing Linux desktop accessibility (AT-SPI) automation
// to the parent SIRA session only (see src/sira/session.ts) — mirrors
// desktop-bridge-tools.ts's shape exactly, but each handler goes through the
// desktop-bridge daemon's /atspi/* routes (src/desktop-bridge/atspi/)
// instead of /actions/*. Semantic, accessible-role/name-based control —
// prefer these over desktop_* coordinate tools for native GTK/Qt apps.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SystemConfig } from '../shared/config.ts';
import { callAtspiAction } from '../desktop-bridge/atspi/client.ts';
import { toCallToolResult } from './desktop-bridge-tools.ts';
import type { ToolResult } from './types.ts';

export interface AtspiToolServerDeps {
  cfg: SystemConfig;
  agentKey: string;
  conversationId: string;
}

export interface AtspiToolServer {
  server: ReturnType<typeof createSdkMcpServer>;
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

export function buildAtspiToolServer(deps: AtspiToolServerDeps): AtspiToolServer {
  const dispatch = (action: string, args: Record<string, unknown>): Promise<ToolResult> =>
    callAtspiAction(deps.cfg, { tool: action, args, agentKey: deps.agentKey, conversationId: deps.conversationId });
  const callTool = dispatch;
  const run = (action: string, args: Record<string, unknown>): Promise<ReturnType<typeof toCallToolResult>> =>
    dispatch(action, args).then(toCallToolResult);

  const server = createSdkMcpServer({
    name: 'sira-atspi',
    tools: [
      tool('atspi_list_apps', 'List running desktop applications that expose an accessibility tree.',
        {}, () => run('list_apps', {})),
      tool('atspi_find', 'Search for accessible elements by app name, role (e.g. "push button", "text"), and/or a name pattern. Use this to check what is available before clicking.',
        { app: z.string().optional(), role: z.string().optional(), name_pattern: z.string().optional() }, (a) => run('find', a)),
      tool('atspi_click', 'Click a native Linux app element by its accessible role/name — no screenshot needed. Prefer this over desktop_click for GNOME/GTK/Qt apps.',
        { app: z.string().optional(), role: z.string().optional(), name_pattern: z.string().min(1).max(500) }, (a) => run('click', a)),
      tool('atspi_set_text', 'Set the text of a native app text field by its accessible role/name.',
        { app: z.string().optional(), role: z.string().optional(), name_pattern: z.string().min(1).max(500), text: z.string().max(20000) }, (a) => run('set_text', a)),
      tool('atspi_get_text', 'Read the text of a native app element by its accessible role/name.',
        { app: z.string().optional(), role: z.string().optional(), name_pattern: z.string().min(1).max(500) }, (a) => run('get_text', a)),
      tool('atspi_wait_for', 'Wait for a native app element to appear (by accessible role/name) instead of guessing a fixed delay.',
        {
          app: z.string().optional(), role: z.string().optional(), name_pattern: z.string().min(1).max(500),
          timeout_ms: z.number().int().min(100).max(30000).optional(),
        }, (a) => run('wait_for', a)),
    ],
  });
  return { server, callTool };
}

export const ATSPI_TOOL_NAMES = [
  'atspi_list_apps', 'atspi_find', 'atspi_click', 'atspi_set_text', 'atspi_get_text', 'atspi_wait_for',
];
