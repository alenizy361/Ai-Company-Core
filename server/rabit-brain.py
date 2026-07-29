#!/usr/bin/env python3
"""Rabit AI brain — chat + memory + real-execution backend for the dashboard.

Listens on 127.0.0.1:$RABIT_PORT behind nginx (see server/install.sh).

Endpoints (all POST/GET take + return JSON):
  GET  /api/health                 -> status (open, no auth)
  POST /api/chat  {message,lang}    -> {reply, team, order?}   (auth required)
  POST /api/confirm {job_spec,...}  -> {job_id}                (auth required)
  GET  /api/job?id=..               -> {status, deliverable}   (auth required)
  POST /api/tts   {text,lang}       -> audio/mpeg | 204        (auth required)

Auth: when RABIT_TOKEN is set, every endpoint except /api/health requires
`Authorization: Bearer <token>`. The dashboard stores it after the owner
types the access code once. (install.sh always generates a token.)

Brains, preferred first:
  * "api" — ANTHROPIC_API_KEY set and the anthropic SDK imports
  * "cli" — a logged-in Claude Code CLI (Max plan) on this machine

Persistent state lives in a SQLite file (RABIT_DB): conversation history +
the execution job queue. A separate worker process (rabit-worker.py) runs the
jobs. Long-term facts about the owner live in a plain memory file
(RABIT_MEMORY) that gets injected into the system prompt every turn.
"""
import glob
import hmac
import json
import os
import re
import secrets
import shutil
import sqlite3
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _int_env(name, default):
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


PORT = _int_env("RABIT_PORT", 8787)
MODEL = os.environ.get("RABIT_MODEL", "claude-opus-5")
RATE_LIMIT = _int_env("RABIT_RATE", 120)
API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
HOME = os.environ.get("HOME", "/root")
TOKEN = os.environ.get("RABIT_TOKEN", "").strip()
DB_PATH = os.environ.get("RABIT_DB", "/opt/rabit-brain/rabit.db")
MEMORY_PATH = os.environ.get("RABIT_MEMORY", "/opt/rabit-brain/memory.md")
STATUS_PATH = os.environ.get("RABIT_STATUS", "/opt/rabit-brain/status.json")
DELIVER_URL_BASE = os.environ.get("RABIT_DELIVER_URL", "/deliverables")
EXEC_ENABLED = os.environ.get("RABIT_EXEC", "1") not in ("0", "", "no", "false")
TTS_MODE = os.environ.get("RABIT_TTS", "browser").lower()

AGENT_KEYS = ["FE", "BE", "QA", "SEC", "DB", "AN", "UX", "MKT", "FIN"]
OWNER_SID = "owner"  # single-owner product: all authed traffic is the owner

BASE_SYSTEM = """\
You are "RABIT AI CORE", the intelligence behind the owner's Rabit dashboard.
You are Claude, made by Anthropic, speaking directly with the dashboard's owner
(address them as "يا مدير" in Arabic or "boss" in English when it fits naturally).

GROUND TRUTH about this system — your replies must never contradict it:
- The dashboard shows AI employee icons, referenced by key: FE frontend,
  BE backend, QA quality assurance, SEC security, DB database, AN analytics,
  UX design, MKT marketing, FIN finance. Picking a "team" lights those icons
  on the owner's board as a visual aid — it does NOT by itself do any work.
- REAL execution: the ONLY real work that happens is when you return an
  "order" object AND the owner then taps Confirm. That runs Claude with file
  tools in a locked sandbox and produces a real deliverable (a web page,
  report, document, or code) the owner can open at a link. Everything else
  (icons, activity animation) is just visualization.
- NEVER claim work is done, underway, or delivered on your own. Only real,
  confirmed jobs produce results, and the dashboard shows the owner the link
  when a job finishes — you do not announce fake completion or invent results.
- If asked whether something was actually done, answer truthfully from the
  facts you were given (job status, server status). If you don't know, say so.

WHEN TO RETURN AN ORDER (the "order" field):
- Return an order ONLY for a concrete build/writing task that file tools can
  produce inside a sandbox with no internet and no shell — e.g. a landing page,
  an HTML site, a written report or document, a script, sample code, a plan
  file. Put a clear, self-contained English spec in order.spec (the sandboxed
  Claude will only see that spec, not this chat), and a short title.
- Do NOT return an order for things that need real accounts, deployment,
  payments, sending messages, or internet access — for those, help by advising
  or writing the content directly in your reply, and set order to null.
- For pure questions, chat, or small talk: order is null and team is [].

Always answer with a single JSON object:
{"reply": "...", "team": [ ... ], "order": null | {"title": "...", "spec": "..."}}
- reply: SAME language as the owner (Arabic/English), 1-3 short sentences
  (spoken aloud via TTS). Confident, warm, practical, strictly truthful.
  If you return an order, tell the owner you prepared it and they can tap
  Confirm to run it for real.
- team: agent keys to light up for a work order, or [].
Never use emojis or emoticons anywhere in the reply."""

SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "team": {"type": "array", "items": {"type": "string", "enum": AGENT_KEYS}},
        "order": {
            "anyOf": [
                {"type": "null"},
                {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "spec": {"type": "string"},
                    },
                    "required": ["title", "spec"],
                    "additionalProperties": False,
                },
            ]
        },
    },
    "required": ["reply", "team", "order"],
    "additionalProperties": False,
}

# ---------------- pick a brain ----------------
anthropic_client = None
CLAUDE_BIN = None
if API_KEY:
    try:
        import anthropic
        anthropic_client = anthropic.Anthropic()
    except ImportError:
        pass
if anthropic_client is None:
    cands = [os.environ.get("RABIT_CLAUDE_BIN"), shutil.which("claude"),
             "/usr/local/bin/claude", HOME + "/.local/bin/claude",
             HOME + "/.npm-global/bin/claude", "/usr/bin/claude",
             HOME + "/.claude/local/claude"]
    cands += sorted(glob.glob(HOME + "/.nvm/versions/node/*/bin/claude"), reverse=True)
    for c in cands:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            CLAUDE_BIN = c
            break

# ask_cli is defined in the shared worker helper so brain + worker agree
import importlib.util as _ilu
_hp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rabit_claude.py")
_spec = _ilu.spec_from_file_location("rabit_claude", _hp)
rabit_claude = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(rabit_claude)


def cli_logged_in():
    return any(os.path.exists(os.path.join(HOME, p))
               for p in (".claude/.credentials.json", ".claude.json", ".claude"))


def brain_kind():
    if anthropic_client is not None:
        return "api"
    if CLAUDE_BIN and cli_logged_in():
        return "cli"
    return "none"


def brain_hint():
    if brain_kind() != "none":
        return ""
    if CLAUDE_BIN:
        return "claude CLI found but no login — run: claude login, then restart rabit-brain"
    if API_KEY:
        return "ANTHROPIC_API_KEY set but anthropic SDK missing — pip3 install anthropic, then restart"
    return "set ANTHROPIC_API_KEY in /etc/rabit-brain.env or install+login the claude CLI, then restart"


# ---------------- storage ----------------
db_lock = threading.Lock()


def db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    with db_lock, db() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS messages(
            id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT, role TEXT,
            content TEXT, ts REAL)""")
        c.execute("""CREATE TABLE IF NOT EXISTS jobs(
            id TEXT PRIMARY KEY, sid TEXT, title TEXT, spec TEXT,
            status TEXT, deliverable TEXT, error TEXT, created REAL, updated REAL)""")


def history_for(sid, limit=16):
    with db_lock, db() as c:
        rows = c.execute(
            "SELECT role, content FROM messages WHERE sid=? ORDER BY id DESC LIMIT ?",
            (sid, limit)).fetchall()
    return [{"role": r, "content": t} for r, t in reversed(rows)]


def remember(sid, user_msg, reply):
    now = time.time()
    with db_lock, db() as c:
        c.execute("INSERT INTO messages(sid,role,content,ts) VALUES(?,?,?,?)",
                  (sid, "user", user_msg, now))
        c.execute("INSERT INTO messages(sid,role,content,ts) VALUES(?,?,?,?)",
                  (sid, "assistant", reply, now))
        # keep only the most recent 200 turns per session
        c.execute("""DELETE FROM messages WHERE sid=? AND id NOT IN
                     (SELECT id FROM messages WHERE sid=? ORDER BY id DESC LIMIT 200)""",
                  (sid, sid))


def enqueue_job(sid, title, spec):
    # unguessable id: deliverable URLs must not be enumerable by outsiders
    now = time.time()
    for _ in range(5):
        jid = "job_" + secrets.token_hex(12)
        try:
            with db_lock, db() as c:
                c.execute("""INSERT INTO jobs(id,sid,title,spec,status,deliverable,error,created,updated)
                             VALUES(?,?,?,?, 'queued', '', '', ?, ?)""",
                          (jid, sid, title, spec, now, now))
            return jid
        except sqlite3.IntegrityError:
            continue
    raise RuntimeError("could not allocate job id")


def get_job(jid):
    with db_lock, db() as c:
        row = c.execute(
            "SELECT id,title,status,deliverable,error FROM jobs WHERE id=?", (jid,)).fetchone()
    if not row:
        return None
    d = dict(zip(("id", "title", "status", "deliverable", "error"), row))
    if d["deliverable"]:
        d["url"] = DELIVER_URL_BASE.rstrip("/") + "/" + d["id"] + "/"
    return d


def read_memory():
    try:
        with open(MEMORY_PATH, encoding="utf-8") as f:
            t = f.read().strip()
        return t[:4000] if t else ""
    except OSError:
        return ""


def read_status():
    try:
        with open(STATUS_PATH, encoding="utf-8") as f:
            s = json.load(f)
    except (OSError, json.JSONDecodeError):
        return ""
    bits = []
    if "disk_pct" in s:
        bits.append("disk %s%% used" % s["disk_pct"])
    if "load" in s:
        bits.append("load %s" % s["load"])
    if "ram_pct" in s:
        bits.append("RAM %s%% used" % s["ram_pct"])
    if "services" in s:
        down = [k for k, v in s["services"].items() if v != "active"]
        bits.append("all services up" if not down else "DOWN: " + ", ".join(down))
    return "; ".join(bits)


def system_prompt():
    parts = [BASE_SYSTEM]
    mem = read_memory()
    if mem:
        parts.append("\n\nWHAT YOU KNOW ABOUT THE OWNER (from long-term memory):\n" + mem)
    st = read_status()
    if st:
        parts.append("\n\nLIVE SERVER STATUS (real, updated every few minutes): " + st)
    if not EXEC_ENABLED:
        parts.append("\n\nNOTE: real execution is currently OFF, so always set order to null "
                     "and help by advising or writing content directly in your reply.")
    return "".join(parts)


# ---------------- rate limit ----------------
hits = {}
hits_lock = threading.Lock()


def allowed(ip):
    now = time.time()
    with hits_lock:
        if len(hits) > 5000:
            for k in [k for k, v in hits.items() if not v or now - v[-1] > 3600]:
                del hits[k]
            if len(hits) > 20000:
                hits.clear()
        recent = [t for t in hits.get(ip, []) if now - t < 3600]
        if len(recent) >= RATE_LIMIT:
            hits[ip] = recent
            return False
        recent.append(now)
        hits[ip] = recent
        return True


# ---------------- brain calls ----------------
def parse_brain_json(text):
    m = re.search(r"\{.*\}", text.strip(), re.S)
    if m:
        try:
            d = json.loads(m.group(0))
            reply = str(d.get("reply", "")).strip()
            team = [k for k in (d.get("team") or []) if k in AGENT_KEYS]
            order = d.get("order")
            if not (isinstance(order, dict) and order.get("title") and order.get("spec")):
                order = None
            if reply:
                return reply, team, order
        except (json.JSONDecodeError, TypeError):
            pass
    return text.strip(), [], None


def ask_api(history, message):
    msgs = history + [{"role": "user", "content": message}]
    kwargs = dict(model=MODEL, max_tokens=2500, system=system_prompt(), messages=msgs,
                  output_config={"effort": "low",
                                 "format": {"type": "json_schema", "schema": SCHEMA}})
    try:
        resp = anthropic_client.beta.messages.create(
            betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs)
    except (TypeError, AttributeError):
        try:
            resp = anthropic_client.messages.create(**kwargs)
        except TypeError:
            kwargs.pop("output_config", None)
            resp = anthropic_client.messages.create(**kwargs)
    if resp.stop_reason == "refusal":
        return None, [], None
    if resp.stop_reason == "max_tokens":
        raise RuntimeError("brain reply was truncated (max_tokens)")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    reply, team, order = parse_brain_json(text)
    if not reply:
        raise RuntimeError("empty reply from brain")
    return reply, team, order


def ask_cli(history, message):
    text = rabit_claude.chat(CLAUDE_BIN, system_prompt(), history, message, HOME)
    reply, team, order = parse_brain_json(text)
    if not reply:
        raise RuntimeError("empty reply from brain")
    return reply, team, order


# ---------------- neural TTS proxy (optional) ----------------
def synth_tts(text, lang):
    text = text[:1200]
    if TTS_MODE == "azure":
        key = os.environ.get("AZURE_TTS_KEY", ""); region = os.environ.get("AZURE_TTS_REGION", "")
        if not key or not region:
            return None
        voice = "ar-SA-HamedNeural" if lang == "ar" else "en-US-GuyNeural"
        ssml = ("<speak version='1.0' xml:lang='%s'><voice name='%s'>%s</voice></speak>"
                % ("ar-SA" if lang == "ar" else "en-US", voice,
                   text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")))
        req = urllib.request.Request(
            "https://%s.tts.speech.microsoft.com/cognitiveservices/v1" % region,
            data=ssml.encode("utf-8"),
            headers={"Ocp-Apim-Subscription-Key": key, "Content-Type": "application/ssml+xml",
                     "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
                     "User-Agent": "rabit"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.read()
    if TTS_MODE == "elevenlabs":
        key = os.environ.get("ELEVEN_KEY", "")
        vid = os.environ.get("ELEVEN_VOICE", "21m00Tcm4TlvDq8ikWAM")
        if not key:
            return None
        req = urllib.request.Request(
            "https://api.elevenlabs.io/v1/text-to-speech/%s" % vid,
            data=json.dumps({"text": text, "model_id": "eleven_multilingual_v2"}).encode(),
            headers={"xi-api-key": key, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.read()
    return None


# ---------------- telegram helper (used by routines via import) ----------------
def telegram_send(text):
    tok = os.environ.get("TELEGRAM_TOKEN", ""); chat = os.environ.get("TELEGRAM_CHAT_ID", "")
    if not tok or not chat:
        return False
    try:
        req = urllib.request.Request(
            "https://api.telegram.org/bot%s/sendMessage" % tok,
            data=json.dumps({"chat_id": chat, "text": text[:4000]}).encode(),
            headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=15).read()
        return True
    except Exception:
        return False


# ---------------- HTTP ----------------
class Handler(BaseHTTPRequestHandler):
    server_version = "RabitBrain/2.0"
    timeout = 30

    def log_message(self, *a):
        pass

    def _client_ip(self):
        peer = self.client_address[0]
        if peer in ("127.0.0.1", "::1"):
            real = self.headers.get("X-Real-IP", "").strip()
            if real:
                return real
            xff = self.headers.get("X-Forwarded-For", "")
            if xff:
                return xff.split(",")[-1].strip()
        return peer

    def _authed(self):
        # fail CLOSED: with no token configured, protected endpoints stay shut
        # (public box — better a locked-out owner who fixes config than an
        # open door). The installer always writes a token.
        if not TOKEN:
            return False
        got = self.headers.get("Authorization", "")
        if got.startswith("Bearer "):
            return hmac.compare_digest(got[7:].strip(), TOKEN)
        return False

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if n <= 0 or n > 65536:
            return None
        try:
            d = json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, json.JSONDecodeError, OSError):
            return None
        return d if isinstance(d, dict) else None

    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/")
        if path == "/api/health":
            out = {"ok": True, "brain": brain_kind(), "model": MODEL,
                   "exec": EXEC_ENABLED, "tts": TTS_MODE, "auth": bool(TOKEN)}
            h = brain_hint()
            if h:
                out["hint"] = h
            self._send(200, out)
            return
        if path == "/api/job":
            if not self._authed():
                self._send(401, {"error": "unauthorized"}); return
            from urllib.parse import parse_qs, urlparse
            jid = (parse_qs(urlparse(self.path).query).get("id") or [""])[0]
            j = get_job(jid)
            self._send(200 if j else 404, j or {"error": "not found"})
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")
        if not self._authed():
            self._send(401, {"error": "unauthorized"}); return
        if not allowed(self._client_ip()):
            self._send(429, {"reply": "وصلنا الحد الأقصى من الطلبات مؤقتًا — جرب بعد شوي يا مدير.",
                             "team": [], "order": None})
            return
        data = self._read_json()
        if data is None:
            self._send(400, {"error": "bad request"}); return

        if path == "/api/tts":
            text = str(data.get("text", "")).strip()
            if not text or TTS_MODE == "browser":
                self._send(204 if TTS_MODE == "browser" else 400, {}); return
            try:
                audio = synth_tts(text, data.get("lang", "ar"))
            except Exception:
                audio = None
            if not audio:
                self._send(204, {}); return
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
            return

        if path == "/api/confirm":
            if not EXEC_ENABLED:
                self._send(403, {"error": "execution disabled"}); return
            title = str(data.get("title", "")).strip()[:200]
            spec = str(data.get("spec", "")).strip()[:8000]
            if not spec:
                self._send(400, {"error": "empty spec"}); return
            try:
                jid = enqueue_job(OWNER_SID, title or "task", spec)
            except Exception as exc:
                self._send(500, {"error": str(exc)[:200]}); return
            self._send(200, {"job_id": jid, "status": "queued"})
            return

        if path == "/api/chat":
            if brain_kind() == "none":
                self._send(503, {"error": "no brain", "hint": brain_hint()}); return
            message = str(data.get("message", "")).strip()[:4000]
            if not message:
                self._send(400, {"error": "empty message"}); return
            sid = OWNER_SID if TOKEN else str(data.get("session", "anon"))[:64]
            history = history_for(sid)
            try:
                if anthropic_client is not None:
                    reply, team, order = ask_api(history, message)
                else:
                    reply, team, order = ask_cli(history, message)
            except Exception as exc:
                self._send(502, {"error": ("brain error: %s" % exc)[:300]}); return
            if reply is None:
                reply = ("ما أقدر أساعد في هذا الطلب يا مدير." if data.get("lang") == "ar"
                         else "I can't help with that request, boss.")
                team, order = [], None
            if not EXEC_ENABLED:
                order = None
            remember(sid, message, reply)
            self._send(200, {"reply": reply, "team": team, "order": order})
            return

        self._send(404, {"error": "not found"})


if __name__ == "__main__":
    init_db()
    print("Rabit brain on 127.0.0.1:%d — brain=%s model=%s exec=%s tts=%s auth=%s"
          % (PORT, brain_kind(), MODEL, EXEC_ENABLED, TTS_MODE, bool(TOKEN)), flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
