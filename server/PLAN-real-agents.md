# Plan: make the board real (no simulation, no canned output)

Goal: when an agent lights up, it is **actually running**. Every line in the
feed reflects a **real** event. No hardcoded logs, no random pings, no fake
completion, no ambient filler.

## The honest model

An owner order becomes a **project** = an ordered list of **steps**. Each step
is assigned to a real agent role (UX/FE/BE/QA/…) and is executed as a **real
`claude` run with file tools** in a **shared project workspace**. Steps run
sequentially; each reads the files the previous steps produced (real handoff).
The board and feed are driven entirely by the **real** status of those steps.

Honest about limits: steps run one-at-a-time (shared Max-plan quota + safety),
not as 9 parallel autonomous employees. But everything shown is TRUE — a
"running" agent is running `claude` right now; "wrote index.html" appears
because the file was actually written.

## Backend (rabit-brain.py + rabit-worker.py)

- Brain planner returns `{reply, team, plan}` where `plan` is
  `[{agent, title, spec}, …]` (2–4 steps) or `null`. Each `spec` is
  self-contained English and may say "read the files from earlier steps".
- DB: `projects(id,title,status,deliverable,created,updated)` and
  `steps(id,project_id,seq,agent,title,spec,status,files,error,started,ended)`.
- `POST /api/confirm {title, plan}` → create project + steps → return `project_id`.
- `GET /api/project?id=` → real-time `{status, deliverable, url, steps:[{agent,title,status,files,error}]}`.
- Worker: claim a queued project; for each step in order → mark `running`,
  snapshot the workspace, run `claude -p <spec>` (Read/Write/Edit only, no bash,
  no internet) in the SHARED workspace, diff the files, mark `done` with the
  real new/changed file list (or `failed` with the real error), then next step.
  Publish the final workspace to `/deliverables/<project>/`.

## Dashboard (index.html)

- **Delete** the fake engine: `logs`, `says`, `PINGS`, `runAgent`, `ambient`,
  `wakeBoard`, `startMission`/`finishMission` canned mission, random inter-agent
  pings.
- **Add** a real project renderer: on Confirm → `POST /api/confirm` (plan) →
  poll `GET /api/project`. Drive the board from REAL step status — the agent
  whose step is `running` lights up; done agents show a done chip; the feed
  appends REAL lines only ("UX ▶ started", "UX ✔ wrote design.md", "FE ▶
  started", real handoff), derived from step deltas. Final → real deliverable link.
- Idle board is calm (no fake filler). Core status reflects real project state.
- Decorative canvas (core, bolts, float) stays — it claims nothing.

## Verify

Run a real 2–3 step project end-to-end; confirm each step actually runs
`claude`, real files appear, statuses are truthful, and a real deliverable link
opens. No canned string reaches the user.
