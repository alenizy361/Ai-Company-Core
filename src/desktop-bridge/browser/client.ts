// API-server-side HTTP client to the desktop-bridge daemon's /browser/*
// routes — mirrors ../client.ts's callDesktopAction() exactly. Never throws
// on a network failure — a disconnected/not-running daemon is a normal,
// expected state, reported honestly to the model as a failed tool result.
import type { SystemConfig } from '../../shared/config.ts';
import type { ToolResult } from '../../tools/types.ts';

export interface BrowserActionRequest {
  tool: string;
  args: Record<string, unknown>;
  agentKey: string;
  conversationId: string | null;
}

export async function callBrowserAction(cfg: SystemConfig, req: BrowserActionRequest): Promise<ToolResult> {
  try {
    const res = await fetch(`${cfg.desktopBridgeUrl}/browser/${req.tool}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.DESKTOP_BRIDGE_TOKEN ? { authorization: `Bearer ${process.env.DESKTOP_BRIDGE_TOKEN}` } : {}),
      },
      body: JSON.stringify({ args: req.args, agentKey: req.agentKey, conversationId: req.conversationId }),
      signal: AbortSignal.timeout(cfg.browserActionTimeoutMs + 2000), // small margin over the daemon's own bound
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `browser bridge returned ${res.status}: ${text.slice(0, 300)}` };
    }
    return await res.json() as ToolResult;
  } catch (err) {
    return { ok: false, error: `browser bridge unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}
