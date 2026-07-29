# SIRA — Autonomous Company OS

A real, self-contained, voice-first multi-agent company operating system.
An owner speaks (or types) an objective — in English or Arabic; the CEO
agent plans a minimal task graph; the owner confirms; specialist agents
execute with real tools under code-enforced permissions; every claim is
verified against persisted artifacts; the interface renders only backend
truth.

The interface is SIRA itself: a central audio-reactive core surrounded by a
**neural agent network** — real execution nodes that appear when a real plan
assigns them, connected by real dependency/handoff/tool edges, animated only
by persisted events (every pulse carries its event seq). English/LTR is the
default; Arabic/RTL is a first-class mirror (logical-property CSS, bidi
isolation for ids/paths). Replies stream token-by-token visibly and start
speaking at the first complete sentence. Max-4 ranked context cards say why
they surfaced; Ctrl/Cmd+K opens global search (Ask / Find / Navigate); chat
is an optional drawer over the same conversation as voice.

Built on **zero runtime dependencies** beyond the official Anthropic SDK:
Node 22 (`node:sqlite`, `node:test`, native TS type-stripping), a vanilla-JS
PWA client, and the `claude` CLI for subscription-based model access. Each
agent runs on a configurable model tier (fast / balanced / reasoning /
custom) — lowest-cost capable by default, overridable per agent from the
agent inspector (audited).

```
npm ci
npm run seed                 # org + 13 agents + versioned prompts
npm run eval -- --promote    # evaluation-gated agent activation (all 13 must pass)
npm run dev                  # API :4600 + execution worker (separate processes)
# open http://localhost:4600 — tap the mic (or type) and give SIRA an objective
```

Deploying on a dedicated machine (Linux/macOS/WSL2)? One command does all of
the above, verifies the install with the full test + eval suites, and can set
up always-on systemd services with restart policies:

```
./scripts/install-sira.sh --services
```

## The truth architecture

The founding rule: **nothing on screen and nothing an agent says may exist
without a persisted source.**

- The backend owns all status. Agent "activity" is derived from worker
  heartbeats + task rows; a dead worker renders as OFFLINE within 90s, never
  as fake progress. The frontend is `state = reduce(snapshot, SSE events)`
  with zero decorative timers.
- Models never execute anything. Every agent turn is one JSON action; the
  worker validates it, enforces the role's tool/path/command policy in code
  (`src/tools/dispatch.ts` — realpath containment, no-shell command
  allowlists, approval gates), and records every call. Denials are
  persisted events.
- Completion is verified, not claimed. `complete` triggers backend checks
  (artifact existence, content, JSON schema, allowlisted commands); only
  passing checks mark a task done. Failures are first-class honest outcomes.
- Voice states carry source attribution: only real capture may claim
  `listening`, only an in-flight model request `thinking`, only actually
  playing synthesis `speaking`. Fabricated transitions are rejected (HTTP
  422) and recorded for audit.

## Layout

```
config/        13-agent roster, per-role tool permission policy, tuning, voice providers
prompts/       shared immutable core (10 files) + 13 unique role prompts + templates
src/shared/    sqlite wrapper (WAL), migration, ids, status machines, derived state
src/adapters/  model adapters: claude CLI (subscription, canary-guarded),
               Anthropic API, deterministic mock — selection degrades loudly
src/promptreg/ file-seeded, DB-versioned prompts + effective-prompt assembly
src/planning/  {reply, team, plan} contract, mechanical validator, confirm flow
src/tools/     tool registry + THE single permission enforcement point
src/worker/    claims (atomic, leased), agent loop, verification, handoffs, recovery
src/voice/     voice session state machine (19 source-attributed states)
src/evals/     per-agent eval suites (8 categories), promotion gate, rollback
src/server/    HTTP API + SSE hub + converse (voice/text conversation)
web/           voice-first PWA: audio-reactive core, chat drawer, activity board
tests/         40 tests incl. the 9 mandatory acceptance tests (worker-kill
               recovery, malformed output, permission boundary, injection,
               prompt lifecycle, interface truth)
```

## The conversation engine (official Claude Agent SDK)

SIRA's conversation runs on the **official Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`): one persistent parent session per
conversation (streaming input — never a one-shot query per sentence), the
real Claude Code system preset with a SIRA identity append, and real SDK
subagents (`src/sira/agents.ts`: product, ux, frontend, backend, qa, … — no
CEO subagent; the parent session IS the orchestrator). The SDK owns the
execution loop: tool calls, subagent invocation, results returning to the
parent, and the final synthesis. A completed task is an internal event
(`sira.agent.completed` / `sira.execution.completed` on `/api/events`) —
the final user response is ALWAYS the parent session's own conversational
message, streamed as text (`delta`) and as speakable sentences (`say`,
code/URLs/ids stripped by `src/sira/speakable.ts`). SDK session ids are
persisted in `sdk_sessions` and resumed across API restarts. Dangerous Bash
commands pause the session for owner approval (same approvals UI). Without
real Claude auth (or with `ADAPTER=mock` / `SIRA_ENGINE=legacy`) the legacy
contract path answers instead, honestly labeled.

## Model access (Claude Max plan by design)

The execution worker's agents share one Claude subscription via the
`claude` CLI in headless print mode with **all built-in tools disabled** —
a startup canary proves a tool-bait prompt causes no side effects before
the adapter is trusted. `ANTHROPIC_API_KEY` switches to the API adapter;
with neither, the system runs in loudly-labeled MOCK MODE (banner + health
endpoint reason — never silent). Usage is tracked in tokens per
5-hour/weekly quota windows (`/api/usage`) because subscription billing has
no per-token dollars.

## Voice

Works out of the box with browser-native providers (Web Speech STT ar/en,
speechSynthesis TTS, getUserMedia capture with hard mute, tap-to-talk,
<200ms barge-in preserving the unspoken remainder). Every layer sits behind
a provider interface; configuring keys switches the primary path
(`config/voice.json` + `/api/health` provider matrix):

| Layer | Fallback (works now) | Primary when configured |
|---|---|---|
| STT | Web Speech (browser) | Deepgram — `DEEPGRAM_API_KEY` |
| TTS | speechSynthesis | Fish Audio — `FISH_API_KEY` (or legacy `FISH_AUDIO_API_KEY`) |
| Wake word | none → push-to-talk | Porcupine — `PICOVOICE_ACCESS_KEY` |
| Transport | in-page capture | LiveKit — `LIVEKIT_URL/API_KEY/API_SECRET` |

Live integration of the keyed providers is the next milestone once
credentials exist; the selection, labeling, and degradation paths are in
place and tested. Roadmap after that: native mobile clients and an
always-on room device (the server API — short-lived voice session tokens,
SSE, converse — already supports them without changes).

## Agents

13 roles (CEO, PM, UX, Frontend, Backend, Database, QA, Security,
Analytics, Marketing, Finance, Operations, Customer Support), each with a
unique versioned role prompt bound to its exact tool policy. An agent is
NOT plannable until its prompt version passes its 8-category eval suite
(normal / ambiguous / tool-required / impossible / failure-recovery /
prompt-injection / handoff / permission-boundary) at 100% through the real
execution machinery. Prompt improvements ship as candidates, promote only
on measured results, and roll back cleanly (`/api/prompts`, `/api/evals`).

## Tests

`npm test` — typecheck + unit/integration suites, including the nine backend
acceptance tests (worker-kill recovery, malformed output, permission
boundary, injection, prompt lifecycle, interface truth), streaming
(delta/cancellation/say extraction), search, model tiers, i18n dictionary
parity, CSS logical-property lint, and a repo-wide branding scan.

`npm run test:ui` — the nine SIRA interface acceptance tests driven through
real headless Chromium via a zero-dependency CDP client (`tests/ui/`):
branding, default-English persistence, full RTL mirroring, mixed-language
bidi, incremental streaming + stop-with-no-half-answer, barge-in remainder
preservation, network truth against a real worker (real handoff inspection),
killed-worker honesty (zero active nodes, zero pulses), and a 9-viewport ×
2-direction responsive matrix. Skips cleanly when no Chromium is present
(`SIRA_CHROME_BIN` overrides the binary path); it is not part of `npm test`.

## Self-development mode (dedicated machine)

By default agents work inside a sandboxed per-objective workspace and can
never touch SIRA's own code. On a machine dedicated to SIRA, the owner can
grant it the ability to modify itself — interface and code — by adding
`SIRA_SELF_DEV=1` to `~/.config/sira/env` and restarting the services. In
this mode the objective workspace IS the repository, with per-role grants
merged from `config/permissions.selfdev.json`: frontend/UX own `web/**`,
backend owns `src/**` + `prompts/**`, QA owns `tests/**` — everything else
stays denied by the same single enforcement point, every change still goes
through a plan the owner confirms, verification commands (typecheck/tests)
gate completion, and agents commit to git so every change is inspectable
and revertible (`git log`, `git revert`). Ask SIRA "redesign your
interface" and watch the frontend agent do it.

## Migrating from a pre-SIRA install

Everything is automatic: `./scripts/install-sira.sh --services` stops and
removes old `rabit-*` systemd units before enabling `sira-*` (two workers
must never share one database), the seed renames the org row, prompt
re-promotion happens in the installer's eval step, the service worker
deletes old caches, and the client migrates its storage keys once. If your
shell profile exported `RABIT_*` variables, rename them to `SIRA_*`.

## Legacy Paperclip package

The original Paperclip "Agent Companies" config (COMPANY.md, agents/*/
AGENTS.md, .paperclip.yaml, scripts/setup.sh) is preserved untouched for
importing into a self-hosted Paperclip instance; it is independent of the
SIRA OS in this repo. The old simulated demo dashboard has been removed —
the real client lives in `web/` (its visual identity carries on in the
audio-reactive core).
