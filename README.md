# RABIT — Autonomous Company OS

A real, self-contained, voice-first multi-agent company operating system.
An owner speaks (or types) an objective; the CEO agent plans a minimal task
graph; the owner confirms; specialist agents execute with real tools under
code-enforced permissions; every claim is verified against persisted
artifacts; the interface renders only backend truth.

Built on **zero runtime dependencies** beyond the official Anthropic SDK:
Node 22 (`node:sqlite`, `node:test`, native TS type-stripping), a vanilla-JS
PWA client, and the `claude` CLI for subscription-based model access.

```
npm ci
npm run seed                 # org + 13 agents + versioned prompts
npm run eval -- --promote    # evaluation-gated agent activation (all 13 must pass)
npm run dev                  # API :4600 + execution worker (separate processes)
# open http://localhost:4600 — tap the mic (or type) and give RABIT an objective
```

Deploying on a dedicated machine (Linux/macOS/WSL2)? One command does all of
the above, verifies the install with the full test + eval suites, and can set
up always-on systemd services with restart policies:

```
./scripts/install-rabit.sh --services
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

## Model access (Claude Max plan by design)

All agents share one Claude subscription via the `claude` CLI in headless
print mode with **all built-in tools disabled** — a startup canary proves a
tool-bait prompt causes no side effects before the adapter is trusted.
`ANTHROPIC_API_KEY` switches to the API adapter; with neither, the system
runs in loudly-labeled MOCK MODE (banner + health endpoint reason — never
silent). Usage is tracked in tokens per 5-hour/weekly quota windows
(`/api/usage`) because subscription billing has no per-token dollars.

## Voice

Works out of the box with browser-native providers (Web Speech STT ar/en,
speechSynthesis TTS, getUserMedia capture with hard mute, tap-to-talk,
<200ms barge-in preserving the unspoken remainder). Every layer sits behind
a provider interface; configuring keys switches the primary path
(`config/voice.json` + `/api/health` provider matrix):

| Layer | Fallback (works now) | Primary when configured |
|---|---|---|
| STT | Web Speech (browser) | Deepgram — `DEEPGRAM_API_KEY` |
| TTS | speechSynthesis | Fish Audio — `FISH_AUDIO_API_KEY` |
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

`npm test` — typecheck + 40 unit/integration tests, including all nine
mandatory acceptance tests (see `tests/integration/`). CI runs the full
suite plus the mechanical eval tier with no model credentials.

## Legacy Paperclip package

The original Paperclip "Agent Companies" config (COMPANY.md, agents/*/
AGENTS.md, .paperclip.yaml, scripts/setup.sh) is preserved untouched for
importing into a self-hosted Paperclip instance; it is independent of the
RABIT OS in this repo. The old simulated demo dashboard has been removed —
the real client lives in `web/` (its visual identity carries on in the
audio-reactive core).
