// Agent SDK message router: translates raw SDK messages into SIRA
// application events. Operational truth flows one way — SDK -> router ->
// persisted execution_events (+ the live turn consumer). A background/task
// completion maps to sira.agent.completed / sira.execution.completed and
// NEVER to a final user response: the final response is only the parent
// session's own assistant text, captured at the result message.
import type { Db } from '../shared/db.ts';
import { emitEvent } from '../shared/events.ts';
import type { SystemConfig } from '../shared/config.ts';

/** Events surfaced to the live turn consumer (the converse SSE stream). */
export type TurnEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'activity'; type: string; agentKey?: string; tool?: string }
  | { kind: 'final'; text: string; usage: { input: number; output: number }; costUsd: number; numTurns: number }
  | { kind: 'error'; message: string };

interface PendingToolUse {
  name: string;
  agentKey: string | null; // Task tool -> subagent key
}

/**
 * Stateful per-session router. route() returns the turn events to forward to
 * the live consumer; significant lifecycle events are persisted as
 * execution_events (the interface's activity/event surfaces read those).
 */
export class SdkMessageRouter {
  private readonly db: Db;
  private readonly cfg: SystemConfig;
  private readonly conversationId: string;
  private readonly pendingTools = new Map<string, PendingToolUse>();
  sdkSessionId: string | null = null;
  model = '';

  constructor(db: Db, cfg: SystemConfig, conversationId: string) {
    this.db = db;
    this.cfg = cfg;
    this.conversationId = conversationId;
  }

  private persist(type: string, payload: Record<string, unknown>, agentKey?: string | null): void {
    try {
      emitEvent(this.db, {
        type, orgId: this.cfg.orgId, agentKey: agentKey ?? undefined,
        payload: { conversationId: this.conversationId, ...payload },
      });
    } catch { /* event persistence must never break the conversation */ }
  }

  /** Feed one SDK message; returns events for the live turn consumer. */
  route(msg: Record<string, unknown>): TurnEvent[] {
    const out: TurnEvent[] = [];
    const type = msg.type as string;

    if (type === 'system' && msg.subtype === 'init') {
      this.sdkSessionId = String(msg.session_id ?? '');
      this.model = String(msg.model ?? '');
      this.persist('sira.session.initialized', {
        sdkSessionId: this.sdkSessionId, model: this.model,
        agents: (msg.agents as string[] | undefined) ?? [],
      });
      return out;
    }

    if (type === 'stream_event') {
      // Parent partial output only: subagent streams never reach the owner.
      if (msg.parent_tool_use_id === null) {
        const event = msg.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          out.push({ kind: 'delta', text: event.delta.text });
        }
      }
      return out;
    }

    if (type === 'assistant') {
      const content = (msg.message as { content?: unknown[] } | undefined)?.content ?? [];
      for (const rawBlock of content) {
        const block = rawBlock as { type?: string; id?: string; name?: string; input?: Record<string, unknown> };
        if (block.type !== 'tool_use' || !block.id) continue;
        if (block.name === 'Task' || block.name === 'Agent') {
          const agentKey = String(block.input?.subagent_type ?? 'agent');
          this.pendingTools.set(block.id, { name: block.name, agentKey });
          this.persist('sira.agent.started', {
            toolUseId: block.id, description: String(block.input?.description ?? '').slice(0, 300),
          }, agentKey);
          out.push({ kind: 'activity', type: 'sira.agent.started', agentKey });
        } else {
          const owner = typeof msg.parent_tool_use_id === 'string'
            ? this.pendingTools.get(msg.parent_tool_use_id)?.agentKey ?? null
            : null;
          this.pendingTools.set(block.id, { name: block.name ?? 'tool', agentKey: owner });
          this.persist('sira.tool.started', { toolUseId: block.id, tool: block.name }, owner ?? 'sira');
          out.push({ kind: 'activity', type: 'sira.tool.started', tool: block.name, agentKey: owner ?? 'sira' });
        }
      }
      return out;
    }

    if (type === 'user') {
      // Tool results (including subagent completions) flowing back to the parent.
      const content = (msg.message as { content?: unknown[] } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const rawBlock of content) {
          const block = rawBlock as { type?: string; tool_use_id?: string; is_error?: boolean };
          if (block.type !== 'tool_result' || !block.tool_use_id) continue;
          const pending = this.pendingTools.get(block.tool_use_id);
          if (!pending) continue;
          this.pendingTools.delete(block.tool_use_id);
          if (pending.name === 'Task' || pending.name === 'Agent') {
            const type2 = block.is_error ? 'sira.agent.failed' : 'sira.agent.completed';
            this.persist(type2, { toolUseId: block.tool_use_id }, pending.agentKey);
            out.push({ kind: 'activity', type: type2, agentKey: pending.agentKey ?? undefined });
          } else {
            this.persist('sira.tool.completed', {
              toolUseId: block.tool_use_id, tool: pending.name, ok: !block.is_error,
            }, pending.agentKey ?? 'sira');
            out.push({ kind: 'activity', type: 'sira.tool.completed', tool: pending.name, agentKey: pending.agentKey ?? 'sira' });
          }
        }
      }
      return out;
    }

    if (type === 'result') {
      const usage = (msg.usage as { input_tokens?: number; output_tokens?: number } | undefined) ?? {};
      this.persist('sira.execution.completed', {
        subtype: msg.subtype, numTurns: msg.num_turns, costUsd: msg.total_cost_usd,
      });
      if (msg.subtype === 'success') {
        out.push({
          kind: 'final',
          text: String(msg.result ?? ''),
          usage: { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 },
          costUsd: Number(msg.total_cost_usd ?? 0),
          numTurns: Number(msg.num_turns ?? 0),
        });
      } else {
        out.push({ kind: 'error', message: `execution ended: ${String(msg.subtype)}` });
      }
      return out;
    }

    return out;
  }
}
