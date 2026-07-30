// The persistent parent SIRA session on the official Claude Agent SDK.
// One long-lived Query per application conversation (streaming input mode —
// never a one-shot query per sentence). The SDK owns the execution loop:
// tool calls, subagent invocation, result feedback, continuation, and the
// final assistant response. This module owns: input pumping, turn
// demultiplexing, event routing/persistence, approvals, interrupt, and
// session resume across process restarts.
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { query, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Db } from '../shared/db.ts';
import { ulid } from '../shared/ids.ts';
import { emitEvent } from '../shared/events.ts';
import { notify } from '../shared/notify.ts';
import { selfDevEnabled, selfDevRoot, loadPermissions, type Paths, type SystemConfig } from '../shared/config.ts';
import { converseModel } from '../shared/model-tier.ts';
import { resolveClaudeBin } from '../adapters/claude-cli.ts';
import { cliAvailable } from '../adapters/select.ts';
import { buildSiraAgents } from './agents.ts';
import { buildRoleToolServer } from '../tools/sdk-bridge.ts';
import { siraAppendPrompt } from './append-prompt.ts';
import { SdkMessageRouter, type TurnEvent } from './router.ts';

/**
 * Security boundary (Phase 2): paths a Read/Glob/Grep call must never
 * resolve into, regardless of workspace containment — a credential or
 * system path that happens to sit inside the workspace root (e.g. a
 * committed .env) is still off-limits. Defense in depth; the primary
 * boundary is workspace containment below.
 */
const SENSITIVE_PATH_PATTERNS = [
  /\/\.ssh(\/|$)/, /\/\.aws(\/|$)/, /\/\.config\/gcloud(\/|$)/, /\/\.docker(\/|$)/, /\/\.kube(\/|$)/,
  /\/\.gnupg(\/|$)/, /\/\.local\/share\/keyrings(\/|$)/, /\/\.config\/google-chrome(\/|$)/, /\/\.mozilla(\/|$)/,
  /(^|\/)\.env(\..+)?$/, /\/\.netrc$/, /\/\.npmrc$/, /^\/etc\/(shadow|passwd|sudoers|gshadow)/,
  /^\/proc(\/|$)/, /^\/sys(\/|$)/, /^\/dev(\/|$)/,
];

export function isSensitivePath(absPath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(absPath));
}

/** Realpath-based containment (defeats ../ and symlink escapes), matching
 *  src/tools/policy.ts's resolveWorkspacePath — but for an absolute path,
 *  since that's the shape Read/Glob/Grep inputs use. */
export function isContainedIn(absPath: string, root: string): boolean {
  try {
    const rootReal = realpathSync(root);
    let probe = resolve(absPath);
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const probeReal = realpathSync(probe);
    return probeReal === rootReal || probeReal.startsWith(rootReal + sep);
  } catch {
    return false;
  }
}

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
  private lastMessageAtMs = Date.now();
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
    const { agents, mcpServers: subagentMcpServers } = buildSiraAgents(db, cfg, paths, cwd, conversationId);

    // The parent session's OWN tool grant: read + company memory only — no
    // write_file/edit_file/run_command. The parent orchestrates and
    // delegates to specialist subagents for any actual change; this is not
    // a limitation worked around elsewhere, it is the design (see
    // append-prompt.ts's delegation section and SHARED_RULES in agents.ts).
    const parentPolicy = loadPermissions().sira;
    const parentServerKey = 'sira-parent';
    const parentToolServer = buildRoleToolServer({
      db, cfg, policy: parentPolicy, agentKey: 'sira', workspaceRoot: cwd, artifactsDir: paths.artifactsDir,
      orgId: cfg.orgId, conversationId,
    });
    const parentCustomTools = parentPolicy.tools
      .filter((t) => ['read_artifact', 'write_artifact', 'memory_search', 'memory_write', 'task_note'].includes(t))
      .map((t) => `mcp__${parentServerKey}__${t}`);
    const mcpServers = { ...subagentMcpServers, [parentServerKey]: parentToolServer.server };

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
      mcpServers,
      // Explicit allowlist — NOT the claude_code tool preset. Bash and
      // unrestricted Write/Edit are never offered to any SIRA agent, live
      // or delegated: they are removed from the model's context entirely,
      // not merely intercepted below. Read/Glob/Grep stay (read-only, path-
      // checked below); Task is delegation (also gated below); the parent's
      // own write/memory capability is its mcp__sira-parent__* tools.
      tools: ['Read', 'Glob', 'Grep', 'Task', 'WebSearch', 'WebFetch', ...parentCustomTools],
      includePartialMessages: true,
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
          return { behavior: 'allow', updatedInput: input };
        }
        // Read/Glob/Grep are native SDK tools — dispatchTool never sees
        // these calls, so containment + sensitive-path denial is enforced
        // HERE, mirroring src/tools/policy.ts's resolveWorkspacePath for the
        // worker pipeline (same defense, different call site).
        if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
          const rawPath = String((input as { file_path?: string; path?: string }).file_path ?? (input as { path?: string }).path ?? '');
          if (rawPath) {
            const abs = resolve(cwd, rawPath);
            if (isSensitivePath(abs)) {
              return { behavior: 'deny', message: `reading "${rawPath}" is not permitted — this is a sensitive system/credential path, never readable regardless of workspace.` };
            }
            if (!isContainedIn(abs, cwd)) {
              return { behavior: 'deny', message: `"${rawPath}" resolves outside the working directory — SIRA can only read within its workspace.` };
            }
          }
          return { behavior: 'allow', updatedInput: input };
        }
        // Everything else (WebSearch/WebFetch, and every mcp__* custom
        // tool) is allowed through here — the custom tools' own handlers
        // already run the full dispatchTool() enforcement (path policy,
        // command allowlisting, approvals, audit) before doing anything.
        return { behavior: 'allow', updatedInput: input };
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

  /** Wall-clock time of the last SDK message OR queued turn — SiraManager's
   *  idle sweep and cap eviction both read this to find the least-recently-
   *  used turn-inactive session. */
  get lastMessageAt(): number {
    return this.lastMessageAtMs;
  }

  /** True while a turn is being processed — SiraManager must never evict a
   *  session mid-turn, no matter how idle its lastMessageAt looks. */
  get hasActiveTurn(): boolean {
    return this.activeTurn !== null;
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q) {
        this.lastMessageAtMs = Date.now();
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
   *
   * `delegationEnabled`, when given, is applied INSIDE the queued turnChain
   * callback — immediately before the turn's input is pushed — not at the
   * call site. Setting it synchronously before send() (the old behavior)
   * raced: a second overlapping send() for the same conversation could
   * overwrite the flag before the first turn's canUseTool check ever ran.
   * Serializing the write through turnChain ties it to the exact turn it
   * belongs to. Omit it to leave the session's current value untouched
   * (internal callers like the completion bridge don't have an owner-facing
   * toggle to assert).
   */
  send(text: string, delegationEnabled?: boolean): AsyncGenerator<TurnEvent> {
    const turn = new TurnStream();
    this.turnChain = this.turnChain.then(async () => {
      if (this.failed) {
        turn.emit({ kind: 'error', message: `session failed: ${this.failed}` });
        turn.finish();
        return;
      }
      if (delegationEnabled !== undefined) this.delegationEnabled = delegationEnabled;
      this.activeTurn = turn;
      this.lastMessageAtMs = Date.now();
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
          if (Date.now() - this.lastMessageAtMs > 900000) {
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
      this.q.close();
    } catch { /* already closed/dead — the point was to terminate it, not to report on it */ }
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
    let preservedDelegation: boolean | undefined;
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
      // The owner's last explicit delegation choice must survive the rebuild
      // — a fresh SiraSession otherwise defaults back to true, silently
      // reverting a setting the owner turned off.
      preservedDelegation = existing.delegationEnabled;
      existing.close();
      this.sessions.delete(conversationId);
    }
    if (this.sessions.size >= this.cfg.maxSessions) this.evictMostIdle();
    const stored = this.db.get<{ sdk_session_id: string | null }>(
      'SELECT sdk_session_id FROM sdk_sessions WHERE conversation_id = ?', conversationId,
    );
    const session = new SiraSession(this.db, this.cfg, this.paths, conversationId, {
      resume: stored?.sdk_session_id ?? undefined,
      replyLang,
    });
    if (preservedDelegation !== undefined) session.delegationEnabled = preservedDelegation;
    this.sessions.set(conversationId, session);
    return session;
  }

  /** Evict the single most-idle turn-inactive session to make room under the
   *  cap — never a session mid-turn. A no-op (never rejects a new
   *  conversation) if every cached session currently has an active turn. */
  private evictMostIdle(): void {
    let target: [string, SiraSession] | null = null;
    for (const entry of this.sessions) {
      const session = entry[1];
      if (session.hasActiveTurn) continue;
      if (!target || session.lastMessageAt < target[1].lastMessageAt) target = entry;
    }
    if (!target) return;
    target[1].close();
    this.sessions.delete(target[0]);
  }

  /** Evict every turn-inactive session idle longer than `idleMs` — a live
   *  session holds a real CLI subprocess, so an unbounded server lifetime
   *  with no eviction is an unbounded process/memory leak. */
  sweepIdle(idleMs: number): void {
    const now = Date.now();
    for (const [conversationId, session] of this.sessions) {
      if (session.hasActiveTurn) continue;
      if (now - session.lastMessageAt <= idleMs) continue;
      session.close();
      this.sessions.delete(conversationId);
    }
  }

  /**
   * Force a session with NO resume — used when resuming ITSELF is the
   * problem (a dead/expired SDK session id would just fail again). Clears
   * the persisted id too, so the owner's own next live turn doesn't hit the
   * same dead resume either.
   */
  recreate(conversationId: string, replyLang: 'en' | 'ar' | null): SiraSession {
    const existing = this.sessions.get(conversationId);
    const preservedDelegation = existing?.delegationEnabled;
    existing?.close();
    this.sessions.delete(conversationId);
    this.db.run(`UPDATE sdk_sessions SET sdk_session_id = NULL WHERE conversation_id = ?`, conversationId);
    const session = this.getOrCreate(conversationId, replyLang);
    if (preservedDelegation !== undefined) session.delegationEnabled = preservedDelegation;
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
