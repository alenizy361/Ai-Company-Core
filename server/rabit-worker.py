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
import re
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
# build/editor droppings are not deliverables and must never be reported as an
# agent's output — they made step results read like the run had misfired
JUNK_DIRS = {"__pycache__", ".git", "node_modules", ".cache", ".claude",
             ".pytest_cache", ".mypy_cache", ".ipynb_checkpoints", ".venv"}
JUNK_EXT = {".pyc", ".pyo", ".pyd", ".swp", ".swo", ".tmp", ".temp",
            ".lock", ".bak", ".orig", ".rej"}
# what the generated cover page can show inline (bytes)
INLINE_MAX_FILE = 96 * 1024
INLINE_MAX_TOTAL = 512 * 1024
CODE_EXT = {".py", ".js", ".css", ".json", ".csv"}
IMG_EXT = {".png", ".jpg", ".jpeg", ".svg", ".webp"}

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


def project_title(pid):
    try:
        with db() as c:
            row = c.execute("SELECT title FROM projects WHERE id=?", (pid,)).fetchone()
        return (row[0] or "") if row else ""
    except sqlite3.Error:
        return ""


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
    for root, dirs, files in os.walk(ws):
        dirs[:] = [d for d in dirs if d not in JUNK_DIRS and not d.startswith(".")]
        for f in files:
            if f.startswith(".") or os.path.splitext(f)[1].lower() in JUNK_EXT:
                continue
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


def _safe_href(url):
    """Only allow links that can't execute script. Agent-authored text is
    untrusted, so javascript:/data: are dropped rather than rendered."""
    u = url.strip()
    low = u.lower().replace("\t", "").replace("\n", "")
    if low.startswith(("http://", "https://", "mailto:", "#", "/", "./", "../")):
        return u
    if ":" in low.split("/")[0]:
        return ""      # some other scheme — refuse
    return u           # plain relative filename


def _md_inline(s):
    """Inline markdown on already HTML-escaped text."""
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<![*\w])\*([^*\n]+)\*(?!\w)", r"<em>\1</em>", s)
    s = re.sub(r"~~([^~]+)~~", r"<del>\1</del>", s)

    def _link(m):
        href = _safe_href(m.group(2))
        if not href:
            return m.group(1)
        return '<a href="%s" target="_blank" rel="noopener">%s</a>' % (href, m.group(1))

    return re.sub(r"\[([^\]]*)\]\(([^)\s]+)\)", _link, s)


def _md_to_html(md):
    """A small, dependency-free Markdown subset. The whole document is HTML-
    escaped before any transform, so agent output can never inject markup."""
    import html as _h
    lines = _h.escape(md.replace("\r\n", "\n").replace("\r", "\n"),
                      quote=False).split("\n")
    out, para, i, n = [], [], 0, len(lines)

    def flush():
        if para:
            out.append("<p>" + _md_inline(" ".join(para)) + "</p>")
            del para[:]

    while i < n:
        ln = lines[i]
        m = re.match(r"^\s*```+\s*([\w+-]*)\s*$", ln)
        if m:                                        # fenced code
            flush()
            i += 1
            buf = []
            while i < n and not re.match(r"^\s*```+\s*$", lines[i]):
                buf.append(lines[i]); i += 1
            i += 1
            out.append("<pre><code>%s</code></pre>" % "\n".join(buf))
            continue
        if not ln.strip():
            flush(); i += 1; continue
        m = re.match(r"^(#{1,6})\s+(.*)$", ln)
        if m:
            flush()
            lvl = len(m.group(1))
            out.append("<h%d>%s</h%d>" % (lvl, _md_inline(m.group(2).strip()), lvl))
            i += 1; continue
        if re.match(r"^\s*([-*_])(\s*\1){2,}\s*$", ln):
            flush(); out.append("<hr>"); i += 1; continue
        # table: header row followed by a |---|---| separator
        if ln.lstrip().startswith("|") and i + 1 < n and \
           re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[i + 1]):
            flush()
            def cells(row):
                return [c.strip() for c in row.strip().strip("|").split("|")]
            head = cells(ln)
            out.append("<table><thead><tr>" +
                       "".join("<th>%s</th>" % _md_inline(c) for c in head) +
                       "</tr></thead><tbody>")
            i += 2
            while i < n and lines[i].lstrip().startswith("|"):
                out.append("<tr>" + "".join("<td>%s</td>" % _md_inline(c)
                                            for c in cells(lines[i])) + "</tr>")
                i += 1
            out.append("</tbody></table>")
            continue
        m = re.match(r"^\s*(?:[-*+]|\d+[.)])\s+", ln)
        if m:
            flush()
            ordered = bool(re.match(r"^\s*\d", ln))
            tag = "ol" if ordered else "ul"
            out.append("<%s>" % tag)
            while i < n and re.match(r"^\s*(?:[-*+]|\d+[.)])\s+", lines[i]):
                item = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", lines[i])
                out.append("<li>%s</li>" % _md_inline(item.strip()))
                i += 1
            out.append("</%s>" % tag)
            continue
        if ln.lstrip().startswith("&gt;"):
            flush()
            buf = []
            while i < n and lines[i].lstrip().startswith("&gt;"):
                buf.append(re.sub(r"^\s*&gt;\s?", "", lines[i])); i += 1
            out.append("<blockquote>%s</blockquote>" % _md_inline(" ".join(buf)))
            continue
        para.append(ln.strip()); i += 1
    flush()
    return "\n".join(out)


def _is_rtl(text):
    ar = sum(1 for ch in text[:4000] if "؀" <= ch <= "ۿ")
    la = sum(1 for ch in text[:4000] if ch.isascii() and ch.isalpha())
    return ar > la * 0.4


COVER_CSS = """
:root{--bg:#08090B;--card:#14171D;--line:rgba(255,255,255,.10);
--t1:rgba(237,240,246,.95);--t2:rgba(226,230,240,.66);--t3:rgba(226,230,240,.42);
--ok:#4ADE80;--ember:#E8A852}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--t1);font:16px/1.7 -apple-system,
BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
padding:max(20px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right))
max(40px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
.wrap{max-width:860px;margin:0 auto}
header{padding:18px 0 26px;border-bottom:1px solid var(--line);margin-bottom:26px}
h1.top{font-size:24px;margin:0 0 8px;letter-spacing:-.01em}
.meta{color:var(--t3);font-size:13px}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;
background:var(--ok);margin-inline-end:7px;vertical-align:middle}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;
padding:20px 22px;margin-bottom:18px;overflow:hidden}
.fname{font:500 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
color:var(--ember);letter-spacing:.06em;text-transform:uppercase;
margin-bottom:14px;display:flex;justify-content:space-between;gap:12px}
.fsize{color:var(--t3);text-transform:none;letter-spacing:0}
h1,h2,h3,h4,h5,h6{line-height:1.35;margin:1.3em 0 .5em}
h1{font-size:21px}h2{font-size:18px}h3{font-size:16px}
h4,h5,h6{font-size:15px;color:var(--t2)}
p{margin:.7em 0;color:var(--t2)}
ul,ol{margin:.7em 0;padding-inline-start:1.4em;color:var(--t2)}
li{margin:.3em 0}
a{color:#7CC5FF}
code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
background:rgba(255,255,255,.07);padding:2px 6px;border-radius:5px}
pre{background:#0E1014;border:1px solid var(--line);border-radius:10px;
padding:14px 16px;overflow-x:auto;direction:ltr;text-align:left}
pre code{background:none;padding:0;font-size:12.5px;line-height:1.6}
blockquote{margin:.8em 0;padding-inline-start:14px;
border-inline-start:3px solid var(--line);color:var(--t3)}
table{border-collapse:collapse;width:100%;margin:1em 0;font-size:14px;display:block;
overflow-x:auto}
th,td{border:1px solid var(--line);padding:8px 11px;text-align:start}
th{background:rgba(255,255,255,.04);font-weight:600}
td{color:var(--t2)}
hr{border:0;border-top:1px solid var(--line);margin:1.6em 0}
img{max-width:100%;height:auto;border-radius:10px}
.files{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.files a{display:inline-block;background:rgba(255,255,255,.05);
border:1px solid var(--line);border-radius:999px;padding:6px 13px;font-size:13px;
color:var(--t2);text-decoration:none;font-family:ui-monospace,Menlo,monospace}
.files a:hover{border-color:var(--ember);color:var(--ember)}
"""


def _render_cover(dest, title, published):
    """Write an index.html that presents everything the run produced.

    Without this, a project whose output is documents (a QA report, a design
    brief) publishes a directory with no index.html — and nginx, with
    `autoindex off`, answers the dashboard's deliverable link with 403. The
    work existed; the owner just could never open it."""
    import html as _h

    def rank(p):
        base = os.path.basename(p).lower()
        ext = os.path.splitext(p)[1].lower()
        return (0 if base.startswith("readme") else
                1 if ext == ".md" else
                2 if ext in (".txt", ".csv") else
                3 if ext in IMG_EXT else
                4 if ext in (".html", ".htm") else 5, p.lower())

    body, budget, listed = [], INLINE_MAX_TOTAL, []
    for rel in sorted(published, key=rank):
        ext = os.path.splitext(rel)[1].lower()
        path = os.path.join(dest, rel)
        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        listed.append(rel)
        head = ('<div class="fname"><bdi>%s</bdi><bdi class="fsize">%s</bdi></div>'
                % (_h.escape(rel),
                   "%.1f KB" % (size / 1024.0) if size >= 1024 else "%d B" % size))
        if ext in IMG_EXT:
            body.append('<div class="card">%s<img src="%s" alt="%s"></div>'
                        % (head, _h.escape(rel), _h.escape(rel)))
            continue
        if ext in (".md", ".txt") or ext in CODE_EXT:
            if size > INLINE_MAX_FILE or size > budget:
                continue
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    txt = f.read()
            except OSError:
                continue
            budget -= size
            if ext == ".md":
                inner = _md_to_html(txt)
                d = ' dir="rtl"' if _is_rtl(txt) else ' dir="ltr"'
            else:
                inner = "<pre><code>%s</code></pre>" % _h.escape(txt, quote=False)
                d = ""
            body.append('<div class="card">%s<div%s>%s</div></div>' % (head, d, inner))

    chips = "".join('<a href="%s" target="_blank" rel="noopener"><bdi>%s</bdi></a>'
                    % (_h.escape(r), _h.escape(r)) for r in listed)
    rtl = _is_rtl(title)
    count = ("%d ملفات ناتجة" % len(listed) if rtl and len(listed) != 1 else
             "ملف واحد ناتج" if rtl else
             "%d file%s produced" % (len(listed), "" if len(listed) == 1 else "s"))
    page = (
        '<!doctype html>\n<html lang="%s" dir="%s">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
        '<meta name="color-scheme" content="dark">\n<title>%s</title>\n<style>%s</style>\n'
        '</head>\n<body>\n<div class="wrap">\n<header>\n<h1 class="top">%s</h1>\n'
        '<div class="meta"><span class="dot"></span>%s</div>\n'
        '<div class="files">%s</div>\n</header>\n%s\n</div>\n</body>\n</html>\n'
        % ("ar" if rtl else "en", "rtl" if rtl else "ltr",
           _h.escape(title or "Deliverable"), COVER_CSS,
           _h.escape(title or "Deliverable"), count, chips,
           "\n".join(body) or '<div class="card"><p>No previewable files.</p></div>'))
    with open(os.path.join(dest, "index.html"), "w", encoding="utf-8") as f:
        f.write(page)


def publish(pid, ws, title=""):
    dest = os.path.realpath(os.path.join(DELIVER_DIR, pid))
    os.makedirs(dest, exist_ok=True)
    ws_real = os.path.realpath(ws)
    published = []
    for root, dirs, files in os.walk(ws):
        dirs[:] = [d for d in dirs if d not in JUNK_DIRS and not d.startswith(".")
                   and not os.path.islink(os.path.join(root, d))]
        for f in files:
            if f.startswith(".") or os.path.splitext(f)[1].lower() not in PUBLISH_EXT:
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
    if "index.html" not in published and published:
        htmls = [p for p in published if p.lower().endswith((".html", ".htm"))]
        if len(htmls) == 1:
            # a real single-page site — serve it directly, that IS the deliverable
            shutil.copy2(os.path.join(dest, htmls[0]), os.path.join(dest, "index.html"))
        else:
            # documents, or several pages: build a cover so the link always opens
            try:
                _render_cover(dest, title, published)
            except Exception:
                return published
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
        published = publish(pid, ws, project_title(pid))
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
