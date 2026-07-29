#!/usr/bin/env python3
"""Rabit execution worker — turns confirmed orders into real deliverables.

Polls the jobs table in the shared SQLite DB (RABIT_DB). For each queued job it
runs Claude with file tools in a fresh per-job sandbox directory (as this
process's user — install.sh runs it as the non-root `rabit-jobs` user), then
publishes the produced files to RABIT_DELIVER_DIR/<job-id>/ so nginx can serve
them at /deliverables/<job-id>/. One job at a time, so a big job can't fork a
swarm of Claude processes or starve the chat brain's shared Max-plan window.
"""
import glob
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


def claim_one():
    with db() as c:
        row = c.execute(
            "SELECT id,spec,title FROM jobs WHERE status='queued' ORDER BY created LIMIT 1"
        ).fetchone()
        if not row:
            return None
        jid = row[0]
        n = c.execute("UPDATE jobs SET status='running', updated=? WHERE id=? AND status='queued'",
                      (time.time(), jid)).rowcount
        if n == 0:
            return None
    return {"id": jid, "spec": row[1], "title": row[2]}


def finish(jid, status, deliverable="", error=""):
    with db() as c:
        c.execute("UPDATE jobs SET status=?, deliverable=?, error=?, updated=? WHERE id=?",
                  (status, deliverable, error[:2000], time.time(), jid))


def publish(jid, workspace):
    dest = os.path.join(DELIVER_DIR, jid)
    os.makedirs(dest, exist_ok=True)
    published = []
    for root, _dirs, files in os.walk(workspace):
        for f in files:
            ext = os.path.splitext(f)[1].lower()
            if ext not in PUBLISH_EXT:
                continue
            src = os.path.join(root, f)
            if os.path.getsize(src) > 25 * 1024 * 1024:
                continue
            rel = os.path.relpath(src, workspace)
            out = os.path.join(dest, rel)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            shutil.copy2(src, out)
            published.append(rel)
    # if there's no index.html but there is exactly one html file, make it the index
    if "index.html" not in published:
        htmls = [p for p in published if p.lower().endswith((".html", ".htm"))]
        if len(htmls) == 1:
            shutil.copy2(os.path.join(dest, htmls[0]), os.path.join(dest, "index.html"))
            published.append("index.html")
    return published


def process(job, claude_bin):
    jid = job["id"]
    workspace = os.path.join(JOBS_DIR, jid, "workspace")
    try:
        if os.path.exists(os.path.join(JOBS_DIR, jid)):
            shutil.rmtree(os.path.join(JOBS_DIR, jid), ignore_errors=True)
        os.makedirs(workspace, exist_ok=True)
        ok, log = rabit_claude.run_job(claude_bin, job["spec"], workspace, HOME,
                                       max_turns=MAX_TURNS)
        published = publish(jid, workspace)
        if ok and published:
            finish(jid, "done", deliverable=",".join(published[:50]))
        elif published:
            finish(jid, "done", deliverable=",".join(published[:50]),
                   error="claude exited non-zero but produced files")
        else:
            finish(jid, "failed", error=("no files produced. " + log)[-1500:])
    except Exception as exc:
        finish(jid, "failed", error=str(exc)[:1000])
    finally:
        shutil.rmtree(os.path.join(JOBS_DIR, jid), ignore_errors=True)


def main():
    os.makedirs(JOBS_DIR, exist_ok=True)
    os.makedirs(DELIVER_DIR, exist_ok=True)
    claude_bin = find_claude()
    print("Rabit worker up — db=%s claude=%s" % (DB_PATH, claude_bin or "MISSING"), flush=True)
    while True:
        job = None
        if claude_bin:
            try:
                job = claim_one()
            except sqlite3.Error:
                job = None
        if job:
            print("running job %s: %s" % (job["id"], job["title"]), flush=True)
            process(job, claude_bin)
            print("finished job %s" % job["id"], flush=True)
        else:
            time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
