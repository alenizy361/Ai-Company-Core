// API-server-side HTTP client to the desktop-bridge daemon (a separate OS
// process — see index.ts). Never throws on a network failure — a
// disconnected/not-running daemon is a normal, expected state (e.g. the
// owner hasn't installed the desktop-bridge service, or it's mid-restart),
// reported honestly to the model as a failed tool result, same discipline
// as health.ts's chatterboxLive probe.
import type { SystemConfig } from '../shared/config.ts';
import type { ToolResult } from '../tools/types.ts';

export interface DesktopActionRequest {
  tool: string;
  args: Record<string, unknown>;
  agentKey: string;
  conversationId: string | null;
}

export async function callDesktopAction(cfg: SystemConfig, req: DesktopActionRequest): Promise<ToolResult> {
  try {
    const res = await fetch(`${cfg.desktopBridgeUrl}/actions/${req.tool}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.DESKTOP_BRIDGE_TOKEN ? { authorization: `Bearer ${process.env.DESKTOP_BRIDGE_TOKEN}` } : {}),
      },
      body: JSON.stringify({ args: req.args, agentKey: req.agentKey, conversationId: req.conversationId }),
      signal: AbortSignal.timeout(cfg.desktopActionTimeoutMs + 2000), // small margin over the daemon's own bound
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `desktop bridge returned ${res.status}: ${text.slice(0, 300)}` };
    }
    return await res.json() as ToolResult;
  } catch (err) {
    return { ok: false, error: `desktop bridge unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface DesktopBridgeStatus {
  ok: boolean;
  enabled: boolean;
  armed: boolean;
  backend: { kind: string; ready: boolean; reason: string };
  dependencies: Record<string, boolean>;
}

export async function getDesktopBridgeStatus(cfg: SystemConfig): Promise<DesktopBridgeStatus | { ok: false; unreachable: true; error: string }> {
  try {
    const res = await fetch(`${cfg.desktopBridgeUrl}/health`, {
      headers: process.env.DESKTOP_BRIDGE_TOKEN ? { authorization: `Bearer ${process.env.DESKTOP_BRIDGE_TOKEN}` } : {},
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return { ok: false, unreachable: true, error: `desktop bridge returned ${res.status}` };
    return await res.json() as DesktopBridgeStatus;
  } catch (err) {
    return { ok: false, unreachable: true, error: err instanceof Error ? err.message : String(err) };
  }
}

async function callDaemonControl(cfg: SystemConfig, path: 'kill' | 'resume', body: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${cfg.desktopBridgeUrl}/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.DESKTOP_BRIDGE_TOKEN ? { authorization: `Bearer ${process.env.DESKTOP_BRIDGE_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    return { ok: res.ok, error: res.ok ? undefined : `desktop bridge returned ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const killDesktopBridgeDaemon = (cfg: SystemConfig, reason: string) => callDaemonControl(cfg, 'kill', { reason });
export const resumeDesktopBridgeDaemon = (cfg: SystemConfig) => callDaemonControl(cfg, 'resume');
