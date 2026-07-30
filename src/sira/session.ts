// The persistent parent SIRA session on the official Claude Agent SDK.
// One long-lived Query per application conversation (streaming input mode —
// never a one-shot query per sentence). The SDK owns the execution loop:
// tool calls, subagent invocation, result feedback, continuation, and the
// final assistant response. This module owns: input pumping, turn
// demultiplexing, event routing/persistence, approvals, interrupt, and
// session resume across process restarts.
import { existsSync, mkdirSync } from 'node:fs';
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
  private lastMessageAt = Date.now();
  /** Owner toggle: when false, the Task tool is DENIED at runtime — SIRA answers itself. */
  delegationEnabled = true;

  constructor(db: Db, cfg: SystemConfig, paths: Paths, conversationId: string, opts: { resume?: string; replyLang?: 'en' | 'ar' | null }) {
    this.db = db;
    this.cfg = cfg;
    this.conversationId = conversationId;
    this.router = new SdkMessageRouter(db, cfg, conversationId);

    const orgName = db.get<{ name: string }>('SELECT name FROM orgs WHERE id = ?', cfg.orgId)?.name ?? 'SIRA';
    const cwd = selfDevEnabled() ? selfDevRoot() : join(paths.workspaceDir, 'sira', conversationId);
    mkdirSync(cwd, { recursive: true });
    const agents = buildSiraAgents(db, cfg);

    // The subprocess must NOT inherit a parent Claude session identity —
    // when SIRA itself runs inside a Claude Code session (dev, self-dev),
    // an inherited session id would pin every SIRA conversation to that
    // outer session. Auth-related variables are deliberately preserved.
    const env = { ...process.env };
    delete env.CLAUDE_SESSION_ID;
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CLAUDE_CODE_CHILD_SESSION;

    // Prefer the owner's installed CLI (subscription auth guaranteed); when
    // no real path resolves, omit the option so the SDK uses its own bundled
    // native CLI binary — never pass a bare command name it cannot find.
    const claudeBin = resolveClaudeBin();
    const options: Options = {
      cwd,
      env,
      model: converseModel(cfg),
      systemPrompt: {
        type: 'preset', preset: 'claude_code',
        append: siraAppendPrompt({ orgName, replyLang: opts.replyLang ?? null, port: cfg.port, agentKeys: Object.keys(agents) }),
      },
      agents,
      includePartialMessages: true,
      permissionMode: 'acceptEdits',
      ...(claudeBin.includes('/') && existsSync(claudeBin) ? { pathToClaudeCodeExecutable: claudeBin } : {}),
      maxTurns: 80,
      ...(opts.resume ? { resume: opts.resume } : {}),
      canUseTool: async (toolName, input) => {
        if (toolName === 'Task' || toolName === 'Agent') {
          // Owner setting: delegation off = the Task tool is denied by the
          // RUNTIME (not just prompt text) — one voice only, SIRA works alone.
          if (!this.delegationEnabled) {
            return { behavior: 'deny', message: 'The owner disabled subagent delegation — do the work yourself and answer directly.' };
          }
          // One activation truth, checked LIVE against the roster: an agent
          // that is not active cannot think — anywhere, ever.
          const subagent = String((input as { subagent_type?: string }).subagent_type ?? '');
          const lifecycle = db.get<{ lifecycle: string }>('SELECT lifecycle FROM agents WHERE key = ?', subagent)?.lifecycle;
          if (lifecycle !== 'active') {
            return { behavior: 'deny', message: `Agent "${subagent}" is not active in the company roster — delegate to an active agent or do the work yourself.` };
          }
        }
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

  /** True once the underlying SDK query has permanently died (e.g. the CLI
   *  subprocess crashed). Every send() on a failed session errors instantly
   *  — callers must not keep reusing it; see SiraManager.getOrCreate. */
  get isFailed(): boolean {
    return this.failed !== null;
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q) {
        this.lastMessageAt = Date.now();
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
      // The SDK stream ended WITHOUT a result for the live turn (process
      // exit, session close): the turn must terminate honestly, never hang.
      if (this.activeTurn) {
        this.activeTurn.emit({ kind: 'error', message: 'session ended before a final response' });
        this.activeTurn.finish();
        this.activeTurn = null;
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
      this.lastMessageAt = Date.now();
      this.input.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      });
      // Wait for this turn to complete before the next queued send proceeds.
      // Idle watchdog: a wedged CLI (no SDK message at all for 15 minutes)
      // must terminate the turn honestly — the owner is never left hanging.
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (this.activeTurn !== turn) {
            clearInterval(poll);
            resolve();
            return;
          }
          if (Date.now() - this.lastMessageAt > 900000) {
            turn.emit({ kind: 'error', message: 'no response from the model runtime for 15 minutes — turn aborted' });
            turn.finish();
            this.activeTurn = null;
            void this.interrupt();
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
    if (existing) {
      // A session that failed mid-process (e.g. the CLI subprocess crashed)
      // previously stayed cached forever — every future turn for this
      // conversation, live or background, would error instantly with no
      // recovery short of restarting the whole API process. Heal
      // transparently instead: close it and fall through to build a fresh
      // one (still resuming, since the failure may have been transient —
      // recreate() below is the stronger escalation for a resume that is
      // itself the problem).
      if (!existing.isFailed) return existing;
      existing.close();
      this.sessions.delete(conversationId);
    }
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

  /**
   * Force a session with NO resume — used when resuming ITSELF is the
   * problem (a dead/expired SDK session id would just fail again). Clears
   * the persisted id too, so the owner's own next live turn doesn't hit the
   * same dead resume either.
   */
  recreate(conversationId: string, replyLang: 'en' | 'ar' | null): SiraSession {
    const existing = this.sessions.get(conversationId);
    existing?.close();
    this.sessions.delete(conversationId);
    this.db.run(`UPDATE sdk_sessions SET sdk_session_id = NULL WHERE conversation_id = ?`, conversationId);
    return this.getOrCreate(conversationId, replyLang);
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
