# Ai Company Core

An [Agent Companies](https://github.com/paperclipai/paperclip/blob/main/doc/companies/companies-spec.md)
package: the versioned, human-editable definition of an AI-employee
org chart, meant to be imported into a self-hosted
[Paperclip](https://github.com/paperclipai/paperclip) instance.

Paperclip is an open-source orchestration platform that runs teams of AI
agents like company employees — org chart, ticket-based tasks, scheduled
routines, approvals/audit logging. This repo *is not* a fork of Paperclip;
Paperclip itself runs separately (via `npx paperclipai`), and this repo is
just the config it imports. Keeping them separate means this repo stays
small and diffable instead of dragging along Paperclip's full codebase.

## The Max plan caveat — read this first

Every agent here uses Paperclip's `claude_local` adapter authenticated via
a **Claude Max plan subscription login**, not a metered API key. That
means every agent — CEO, Operations Lead, Engineering Lead — shares **one**
Claude account's rate limits: one 5-hour session window, one weekly
Sonnet pool, one weekly Opus pool. This is different from Paperclip's
usual model of independent per-agent API budgets.

Practical implications, already reflected in `.paperclip.yaml`:

- No dollar budgets are set (`budgetMonthlyCents`) — they track per-token
  API cost, which doesn't exist under subscription billing. Watch actual
  capacity via the quota windows Paperclip already polls for this adapter
  (visible in the dashboard), not a cost cap.
- `maxTurnsPerRun` is capped low (60) per agent so one heartbeat can't eat
  the whole shared window.
- The org starts small (3 agents) on purpose. Growing headcount means
  more agents competing for the same quota pool — scale gradually and
  watch the weekly windows before adding more.

## What's in here

```
COMPANY.md                              company metadata + goals
agents/
  ceo/AGENTS.md                         reportsTo: null
  operations-lead/AGENTS.md             reportsTo: ceo
  engineering-lead/AGENTS.md            reportsTo: ceo
projects/onboarding/
  PROJECT.md
  tasks/first-30-days/TASK.md           starter task, assignee: ceo
tasks/weekly-review/TASK.md             recurring, assignee: ceo
.paperclip.yaml                         adapter config, quota notes, cron routine
scripts/setup.sh                        onboard Paperclip + import this company
dashboard/index.html                    voice dashboard (access-code lock, live chat, real-exec)
server/rabit-brain.py                   Claude chat brain: auth + memory + job intake
server/rabit-worker.py                  runs confirmed orders as real file-producing jobs
server/rabit-telegram.py                Telegram bridge (owner-only, proactive + two-way)
server/rabit_claude.py                  shared Claude CLI helpers (chat + tool-enabled build)
server/routines/                        cron: health-monitor, morning-brief, memory-distill
server/install.sh                       one-shot VPS installer (all of the above, hardened)
```

## The voice dashboard ("Rabit")

`dashboard/index.html` is a self-contained Arabic/English voice command center
served by nginx. `server/*` turns it from a visual demo into a real assistant:

- **Real brain** — `rabit-brain.py` sends the owner's chat to Claude (Max-plan
  CLI or `ANTHROPIC_API_KEY`) and returns a spoken reply. Honest by design: the
  agent board is labeled a visual *simulation*; nothing is claimed as real work
  unless a job actually runs.
- **Real hands** — when the owner asks for something a sandbox can build (a web
  page, report, document, code), Claude returns an *order*; the owner taps
  Confirm; `rabit-worker.py` runs Claude with file tools only (no shell, no
  internet) in a per-job workspace and publishes the result to
  `/deliverables/<job>/`.
- **Memory & proactivity** — SQLite conversation history that survives restarts,
  a distilled long-term memory file injected into the prompt, a Telegram bridge
  for morning briefs / alerts / phone chat, and a server-health "eyes" snapshot.
- **Secure by construction** — access-code (bearer token) gate on every endpoint,
  HTTPS via certbot, all services run as a non-root `rabit` user under systemd
  hardening. Run `server/install.sh` on the VPS to set it all up.

This voice layer is independent of the Paperclip company package below.

## Quickstart

Run this on the machine that will actually host Paperclip long-term (a
CI runner or short-lived dev container won't keep agents working on
schedule):

1. Install [Claude Code](https://claude.com/claude-code) and log in with
   your Max plan account:
   ```sh
   claude login
   ```
2. Run the setup script from this repo:
   ```sh
   ./scripts/setup.sh
   ```
   This runs `npx paperclipai onboard --yes` (installs/starts Paperclip
   with an embedded database) and then
   `npx paperclipai company import . --target new --yes` to load this
   org chart, projects, and tasks as a new company.
3. Open the dashboard (default `http://localhost:3100`). Imported agents
   land with heartbeats **disabled** — review the org chart and the
   `First 30 Days Plan` task, then enable heartbeats when ready.

## Customizing the org

- Add a role: create `agents/<slug>/AGENTS.md` with `reportsTo` pointing
  at an existing agent slug, and add a matching entry under `agents:` in
  `.paperclip.yaml`.
- Add work: drop a `TASK.md` under a project's `tasks/` folder, or at
  repo root for company-wide recurring work (see `tasks/weekly-review/`
  for the recurring + cron pattern).
- Group a growing org: once you have more than a couple of reports under
  one lead, add a `TEAM.md` for that subtree (see the
  [companies spec](https://github.com/paperclipai/paperclip/blob/main/doc/companies/companies-spec.md#7-teammd)).

After editing, re-import to apply changes to an existing company:

```sh
npx paperclipai company import . --target existing --company-id <id> --dry-run
npx paperclipai company import . --target existing --company-id <id>
```

Use `--collision rename|skip` to control how naming conflicts with
existing agents/projects are handled (see Paperclip's
[import/export docs](https://github.com/paperclipai/paperclip/blob/main/docs/guides/board-operator/importing-and-exporting.md)).

## Beyond this starter setup

Paperclip supports a lot this repo doesn't set up yet: Docker/production
deployment, multi-company isolation, board approval workflows, other
agent adapters (Codex, Cursor, Gemini, HTTP/webhook). See the
[Paperclip repo](https://github.com/paperclipai/paperclip) and its `docs/`
folder for those.
