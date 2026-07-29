// The persistent parent SIRA session on the official Claude Agent SDK.
// One long-lived Query per application conversation (streaming input mode —
// never a one-shot query per sentence). The SDK owns the execution loop:
// tool calls, subagent invocation, result feedback, continuation, and the
// final assistant response. This module owns: input pumping, turn
// demultiplexing, event routing/persistence, approvals, interrupt, and
// session resume across process restarts.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { query, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Db } from '../shared/db.ts';
import { ulid } from '../shared/ids.ts';
import { emitEvent } from '../shared/events.ts';
import { notify } from '../shared/notify.ts';
import { selfDevEnabled, selfDevRoot, type Paths, type SystemConfig } from '../shared/config.ts';
import { converseModel } from '../shared/model-tier.ts';
import { resolveClaudeBin } from '../adapters/claude-cli.ts';
import { cliAvailable } from '../adapters/select.ts';
import { buildSiraAgents } from './agents.ts';
import { siraAppendPrompt } from './append-prompt.ts';
import { SdkMessageRouter, type TurnEvent } from './router.ts';

/** Commands the owner must explicitly approve, even on a dedicated machine. */
const DANGEROUS_BASH = /\brm\s+-rf\s+[/~]|\bgit\s+push\s+.*--force|\bsudo\b|\bmkfs\b|\bshutdown\b|\breboot\b|\bdd\s+if=/;

class PushableInput implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private ended = false;

  push(message: SDKUserMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.queue.push(message);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift() as SDKUserMessage, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Async queue handed to the converse route for one live turn. */
class TurnStream {
  private queue: TurnEvent[] = [];
  private waiters: ((r: IteratorResult<TurnEvent>) => void)[] = [];
  private done = false;

  emit(event: TurnEvent): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  finish(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  async *events(): AsyncGenerator<TurnEvent> {
    for (;;) {
      if (this.queue.length > 0) {
        yield this.queue.shift() as TurnEvent;
        continue;
      }
      if (this.done) return;
      const result = await new Promise<IteratorResult<TurnEvent>>((resolve) => this.waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}

export class SiraSession {
  readonly conversationId: string;
  private readonly db: Db;
  private readonly cfg: SystemConfig;
  private readonly router: SdkMessageRouter;
  private readonly input = new PushableInput();
  private readonly q: Query;
  private activeTurn: TurnStream | null = null;
  private turnChain: Promise<unknown> = Promise.resolve();
  private failed: string | null = null;

  constructor(db: Db, cfg: SystemConfig, paths: Paths, conversationId: string, opts: { resume?: string; replyLang?: 'en' | 'ar' | null }) {
    this.db = db;
    this.cfg = cfg;
    this.conversationId = conversationId;
    this.router = new SdkMessageRouter(db, cfg, conversationId);

    const orgName = db.get<{ name: string }>('SELECT name FROM orgs WHERE id = ?', cfg.orgId)?.name ?? 'SIRA';
    const cwd = selfDevEnabled() ? selfDevRoot() : join(paths.workspaceDir, 'sira', conversationId);
    mkdirSync(cwd, { recursive: true });

    // The subprocess must NOT inherit a parent Claude session identity —
    // when SIRA itself runs inside a Claude Code session (dev, self-dev),
    // an inherited session id would pin every SIRA conversation to that
    // outer session. Auth-related variables are deliberately preserved.
    const env = { ...process.env };
    delete env.CLAUDE_SESSION_ID;
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CLAUDE_CODE_CHILD_SESSION;

    const options: Options = {
      cwd,
      env,
      model: converseModel(cfg),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: siraAppendPrompt({ orgName, replyLang: opts.replyLang ?? null }) },
      agents: buildSiraAgents(db, cfg),
      includePartialMessages: true,
      permissionMode: 'acceptEdits',
      pathToClaudeCodeExecutable: resolveClaudeBin(),
      maxTurns: 80,
      ...(opts.resume ? { resume: opts.resume } : {}),
      canUseTool: async (toolName, input) => {
        // Runtime-enforced approvals: routine reversible work flows freely;
        // genuinely dangerous commands pause THIS session until the owner
        // decides (same approvals table + UI as the worker pipeline).
        if (toolName !== 'Bash') return { behavior: 'allow', updatedInput: input };
        const cmd = String((input as { command?: string }).command ?? '');
        if (!DANGEROUS_BASH.test(cmd)) return { behavior: 'allow', updatedInput: input };
        const decision = await this.requestApproval(toolName, cmd);
        return decision
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'The owner declined this command.' };
      },
    };

    this.q = query({ prompt: this.input, options });
    void this.pump();
  }

  get sdkSessionId(): string | null {
    return this.router.sdkSessionId;
  }

  get model(): string {
    return this.router.model;
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q) {
        const events = this.router.route(msg as unknown as Record<string, unknown>);
        if (this.router.sdkSessionId) this.persistSessionRow();
        for (const event of events) {
          this.activeTurn?.emit(event);
          if (event.kind === 'final' || event.kind === 'error') {
            this.activeTurn?.finish();
            this.activeTurn = null;
          }
        }
      }
    } catch (err) {
      this.failed = err instanceof Error ? err.message : String(err);
      this.activeTurn?.emit({ kind: 'error', message: this.failed });
      this.activeTurn?.finish();
      this.activeTurn = null;
      this.safeRun(`UPDATE sdk_sessions SET state = 'failed', last_active_at = ? WHERE conversation_id = ?`, Date.now(), this.conversationId);
    }
  }

  /** Background bookkeeping writes must never crash the pump (or outlive a
   *  closing process into an already-closed database). */
  private safeRun(sql: string, ...params: unknown[]): void {
    try {
      this.db.run(sql, ...(params as never[]));
    } catch { /* bookkeeping only */ }
  }

  private persistSessionRow(): void {
    const now = Date.now();
    this.safeRun(
      `INSERT INTO sdk_sessions (conversation_id, sdk_session_id, model, cwd, state, created_at, last_active_at)
       VALUES (?, ?, ?, '', 'active', ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET sdk_session_id = excluded.sdk_session_id, model = excluded.model, state = 'active', last_active_at = excluded.last_active_at`,
      this.conversationId, this.router.sdkSessionId, this.router.model, now, now,
    );
  }

  private async requestApproval(tool: string, command: string): Promise<boolean> {
    const approvalId = ulid('apr');
    const now = Date.now();
    this.db.run(
      `INSERT INTO approvals (id, tool_call_id, execution_id, task_id, summary, requested_at)
       VALUES (?, NULL, NULL, NULL, ?, ?)`,
      approvalId, `SIRA: ${tool} — ${command.slice(0, 300)}`, now,
    );
    emitEvent(this.db, {
      type: 'approval.requested', orgId: this.cfg.orgId,
      payload: { approvalId, tool, subject: command.slice(0, 300), conversationId: this.conversationId },
    });
    notify(this.db, this.cfg.orgId, {
      kind: 'approval_required', priority: 'high',
      title: `Approval required: ${tool}`, body: command.slice(0, 500),
      payload: { approvalId, conversationId: this.conversationId },
    });
    const deadline = Date.now() + this.cfg.approvalTimeoutMs;
    for (;;) {
      const row = this.db.get<{ status: string }>('SELECT status FROM approvals WHERE id = ?', approvalId);
      if (row?.status === 'approved') return true;
      if (row?.status === 'rejected') return false;
      if (Date.now() > deadline) {
        this.db.run(`UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'`, Date.now(), approvalId);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  /**
   * Send one owner turn into the persistent session; returns the live event
   * stream for that turn. Turns are strictly serialized per session.
   */
  send(text: string): AsyncGenerator<TurnEvent> {
    const turn = new TurnStream();
    this.turnChain = this.turnChain.then(async () => {
      if (this.failed) {
        turn.emit({ kind: 'error', message: `session failed: ${this.failed}` });
        turn.finish();
        return;
      }
      this.activeTurn = turn;
      this.input.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      });
      // Wait for this turn to complete before the next queued send proceeds.
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (this.activeTurn !== turn) {
            clearInterval(poll);
            resolve();
          }
        }, 100);
      });
      this.safeRun(`UPDATE sdk_sessions SET last_active_at = ? WHERE conversation_id = ?`, Date.now(), this.conversationId);
    });
    return turn.events();
  }

  /** Barge-in: stop the CURRENT turn only; the session stays alive. */
  async interrupt(): Promise<void> {
    try {
      await this.q.interrupt();
    } catch { /* nothing running */ }
    this.activeTurn?.finish();
    this.activeTurn = null;
  }

  close(): void {
    this.input.end();
    try {
      this.db.run(`UPDATE sdk_sessions SET state = 'closed', last_active_at = ? WHERE conversation_id = ?`, Date.now(), this.conversationId);
    } catch { /* shutdown path — the db may already be closed */ }
  }
}

/**
 * One SiraSession per active conversation. Sessions are resumed (via the
 * persisted SDK session id) when the process restarted since their creation.
 */
export class SiraManager {
  private readonly db: Db;
  private readonly cfg: SystemConfig;
  private readonly paths: Paths;
  private readonly sessions = new Map<string, SiraSession>();

  constructor(db: Db, cfg: SystemConfig, paths: Paths) {
    this.db = db;
    this.cfg = cfg;
    this.paths = paths;
  }

  getOrCreate(conversationId: string, replyLang: 'en' | 'ar' | null): SiraSession {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;
    const stored = this.db.get<{ sdk_session_id: string | null }>(
      'SELECT sdk_session_id FROM sdk_sessions WHERE conversation_id = ?', conversationId,
    );
    const session = new SiraSession(this.db, this.cfg, this.paths, conversationId, {
      resume: stored?.sdk_session_id ?? undefined,
      replyLang,
    });
    this.sessions.set(conversationId, session);
    return session;
  }

  get(conversationId: string): SiraSession | undefined {
    return this.sessions.get(conversationId);
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

/**
 * The SDK engine is available when real Claude auth exists (API key or an
 * authenticated CLI). ADAPTER=mock forces the legacy honest-mock path (tests,
 * demos). SIRA_ENGINE=legacy is an explicit escape hatch.
 */
export function createSiraManager(db: Db, cfg: SystemConfig, paths: Paths): SiraManager | null {
  if (process.env.ADAPTER === 'mock' || process.env.SIRA_ENGINE === 'legacy') return null;
  if (!process.env.ANTHROPIC_API_KEY && !cliAvailable().ok) return null;
  return new SiraManager(db, cfg, paths);
}
