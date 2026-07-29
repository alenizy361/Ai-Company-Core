#!/usr/bin/env python3
"""Rabit execution worker — runs REAL multi-agent projects.

A project is an ordered list of steps. Each step is a real `claude` run with
file tools (Read/Write/Edit only — no shell, no internet) executed IN THE SAME
project workspace, in order, so a later step reads the files earlier steps
produced (real handoff). Per-step status is written to the DB in real time so
the dashboard shows exactly which agent is running now and what it produced —
no simulation, no canned output.

Runs as the non-root `rabit` user under systemd hardening. One project at a
time (shared Max-plan window + safety). Final workspace is published to
/deliverables/<project-id>/.
"""
import glob
import json
import os
import shutil
import sqlite3
import time

HOME = os.environ.get("HOME", "/root")
DB_PATH = os.environ.get("RABIT_DB", "/opt/rabit-brain/rabit.db")
JOBS_DIR = os.environ.get("RABIT_JOBS_DIR", "/srv/rabit-jobs")
DELIVER_DIR = os.environ.get("RABIT_DELIVER_DIR", "/srv/rabit-deliverables")
MAX_TURNS = int(os.environ.get("RABIT_JOB_TURNS", "40"))
POLL_SEC = int(os.environ.get("RABIT_POLL_SEC", "4"))
PUBLISH_EXT = {".html", ".htm", ".css", ".js", ".md", ".txt", ".json",
               ".csv", ".pdf", ".png", ".jpg", ".jpeg", ".svg", ".webp", ".py"}

import importlib.util as _ilu
_hp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rabit_claude.py")
_spec = _ilu.spec_from_file_location("rabit_claude", _hp)
rabit_claude = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(rabit_claude)

SECRET_MARKERS = ["sk-ant-", "-----BEGIN", "refresh_token", "access_token",
                  "ANTHROPIC_API_KEY", "TELEGRAM_TOKEN"]
# only treat the access token as a secret to scan for when it's long enough to
# be a real one (production is 32 hex) — a short token would match normal text
_tok = os.environ.get("RABIT_TOKEN", "")
if len(_tok) >= 16:
    SECRET_MARKERS.append(_tok)


def find_claude():
    cands = [os.environ.get("RABIT_CLAUDE_BIN"), shutil.which("claude"),
             "/usr/local/bin/claude", HOME + "/.local/bin/claude",
             HOME + "/.npm-global/bin/claude", "/usr/bin/claude",
             HOME + "/.claude/local/claude"]
    cands += sorted(glob.glob(HOME + "/.nvm/versions/node/*/bin/claude"), reverse=True)
    for c in cands:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def recover_stale():
    """This worker is the ONLY executor and it just started — so anything still
    marked running (or half-cancelled) in the DB is dead. Fail it immediately
    and honestly instead of leaving the owner a wedged 'running' project."""
    try:
        with db() as c:
            c.execute("""UPDATE steps SET status='failed', error='interrupted (server restarted)'
                         WHERE status='running'""")
            c.execute("""UPDATE projects SET status='failed', error='interrupted (server restarted)',
                         updated=? WHERE status='running'""", (time.time(),))
            c.execute("UPDATE steps SET status='cancelled' WHERE status='queued' AND project_id IN "
                      "(SELECT id FROM projects WHERE status='cancelling')")
            c.execute("UPDATE projects SET status='cancelled', updated=? WHERE status='cancelling'",
                      (time.time(),))
    except sqlite3.Error:
        pass


def claim_project():
    with db() as c:
        row = c.execute("SELECT id,title FROM projects WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
        if not row:
            return None
        pid = row[0]
        if c.execute("UPDATE projects SET status='running', updated=? WHERE id=? AND status='queued'",
                     (time.time(), pid)).rowcount == 0:
            return None
    return pid


def steps_of(pid):
    with db() as c:
        rows = c.execute("SELECT id,agent,title,spec FROM steps WHERE project_id=? ORDER BY seq", (pid,)).fetchall()
    return [dict(zip(("id", "agent", "title", "spec"), r)) for r in rows]


def project_status(pid):
    try:
        with db() as c:
            row = c.execute("SELECT status FROM projects WHERE id=?", (pid,)).fetchone()
        return row[0] if row else "missing"
    except sqlite3.Error:
        return "unknown"


def cancel_requested(pid):
    return project_status(pid) == "cancelling"


def seed_previous(pid, ws):
    """Real continuity: copy the most recent finished project's published files
    into ws/previous/ so steps can genuinely read and build on earlier delivered
    work instead of reviewing an empty folder."""
    try:
        with db() as c:
            row = c.execute("""SELECT id FROM projects WHERE status='done' AND deliverable!=''
                               AND id!=? ORDER BY updated DESC LIMIT 1""", (pid,)).fetchone()
    except sqlite3.Error:
        return []
    if not row:
        return []
    src = os.path.realpath(os.path.join(DELIVER_DIR, row[0]))
    if not os.path.isdir(src) or not src.startswith(os.path.realpath(DELIVER_DIR) + os.sep):
        return []
    dest = os.path.join(ws, "previous")
    copied = []
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d))]
        for f in files:
            sp = os.path.join(root, f)
            if os.path.islink(sp):
                continue
            rel = os.path.relpath(sp, src)
            out = os.path.join(dest, rel)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            try:
                shutil.copy2(sp, out)
                os.chmod(out, 0o444)  # read-only reference — steps write NEW files
                copied.append("previous/" + rel)
            except OSError:
                pass
    return copied


def set_step(step_id, **kw):
    if not kw:
        return
    cols = ",".join("%s=?" % k for k in kw)
    with db() as c:
        c.execute("UPDATE steps SET %s WHERE id=?" % cols, (*kw.values(), step_id))


def set_project(pid, **kw):
    kw["updated"] = time.time()
    cols = ",".join("%s=?" % k for k in kw)
    with db() as c:
        c.execute("UPDATE projects SET %s WHERE id=?" % cols, (*kw.values(), pid))


def snapshot(ws):
    seen = {}
    for root, _d, files in os.walk(ws):
        for f in files:
            p = os.path.join(root, f)
            try:
                seen[os.path.relpath(p, ws)] = os.path.getmtime(p)
            except OSError:
                pass
    return seen


def changed_files(before, ws):
    after = snapshot(ws)
    out = [rel for rel, mt in after.items() if before.get(rel) != mt]
    return sorted(out)


def looks_secret(path):
    try:
        with open(path, "rb") as f:
            txt = f.read(200000).decode("utf-8", "ignore")
    except OSError:
        return True
    return any(m in txt for m in SECRET_MARKERS)


def publish(pid, ws):
    dest = os.path.realpath(os.path.join(DELIVER_DIR, pid))
    os.makedirs(dest, exist_ok=True)
    ws_real = os.path.realpath(ws)
    published = []
    for root, dirs, files in os.walk(ws):
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d))]
        for f in files:
            if os.path.splitext(f)[1].lower() not in PUBLISH_EXT:
                continue
            src = os.path.join(root, f)
            if os.path.islink(src) or not os.path.realpath(src).startswith(ws_real + os.sep):
                continue
            try:
                if os.path.getsize(src) > 25 * 1024 * 1024:
                    continue
            except OSError:
                continue
            if looks_secret(src):
                continue
            rel = os.path.relpath(src, ws)
            out = os.path.join(dest, rel)
            if not os.path.realpath(os.path.dirname(out) or dest).startswith(dest):
                continue
            os.makedirs(os.path.dirname(out), exist_ok=True)
            shutil.copy2(src, out)
            published.append(rel)
    if "index.html" not in published:
        htmls = [p for p in published if p.lower().endswith((".html", ".htm"))]
        if len(htmls) == 1:
            shutil.copy2(os.path.join(dest, htmls[0]), os.path.join(dest, "index.html"))
            published.append("index.html")
    return published


def run_project(pid, claude_bin):
    ws = os.path.join(JOBS_DIR, pid, "workspace")
    try:
        shutil.rmtree(os.path.join(JOBS_DIR, pid), ignore_errors=True)
        os.makedirs(ws, exist_ok=True)
        seed_previous(pid, ws)
        steps = steps_of(pid)
        cancelled = False
        for st in steps:
            if cancel_requested(pid):
                cancelled = True
            if cancelled:
                set_step(st["id"], status="cancelled")
                continue
            set_step(st["id"], status="running", started=time.time())
            before = snapshot(ws)
            # the step's claude may read what earlier steps wrote in this workspace
            ctx = ""
            existing = sorted(before.keys())
            if existing:
                ctx = ("\n\nFiles already in the workspace (you may read them; previous/ holds "
                       "the owner's most recent delivered project as READ-ONLY reference — write "
                       "your outputs at the workspace root, never inside previous/): "
                       + ", ".join(existing[:40]))
            ok, log = rabit_claude.run_job(claude_bin, st["spec"] + ctx, ws, HOME,
                                           max_turns=MAX_TURNS,
                                           should_abort=lambda: cancel_requested(pid))
            files = changed_files(before, ws)
            if log == "cancelled" and not ok:
                set_step(st["id"], status="cancelled", ended=time.time())
                cancelled = True
                continue
            if ok or files:
                set_step(st["id"], status="done", files=",".join(files[:30]), ended=time.time())
            else:
                set_step(st["id"], status="failed", error=("no output. " + log)[-800:], ended=time.time())
        # publish whatever real work exists (even partial, on cancel) — but never
        # republish the seeded previous/ copy as if it were new output
        shutil.rmtree(os.path.join(ws, "previous"), ignore_errors=True)
        published = publish(pid, ws)
        if cancelled:
            set_project(pid, status="cancelled",
                        deliverable=",".join(published[:60]) if published else "")
        elif published:
            set_project(pid, status="done", deliverable=",".join(published[:60]))
        else:
            set_project(pid, status="failed", error="no files were produced")
    except Exception as exc:
        set_project(pid, status="failed", error=str(exc)[:800])
    finally:
        shutil.rmtree(os.path.join(JOBS_DIR, pid), ignore_errors=True)


def main():
    os.makedirs(JOBS_DIR, exist_ok=True)
    os.makedirs(DELIVER_DIR, exist_ok=True)
    recover_stale()
    claude_bin = find_claude()
    print("Rabit worker up — db=%s claude=%s" % (DB_PATH, claude_bin or "MISSING"), flush=True)
    while True:
        pid = None
        if claude_bin:
            try:
                pid = claim_project()
            except sqlite3.Error:
                pid = None
        if pid:
            print("running project %s" % pid, flush=True)
            run_project(pid, claude_bin)
            print("finished project %s" % pid, flush=True)
        else:
            time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
