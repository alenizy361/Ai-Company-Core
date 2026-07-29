#!/usr/bin/env python3
"""Rabit AI brain — tiny chat backend that connects the dashboard to Claude.

Listens on 127.0.0.1:8787 behind nginx (see server/install.sh).

Endpoints:
  GET  /api/health -> {"ok": true, "brain": "api"|"cli"|"none", "model": ...}
  POST /api/chat   -> {"message","lang","session"} => {"reply","team":[...]}

Brains, in order of preference:
  * "api" — ANTHROPIC_API_KEY is set and the official `anthropic` SDK imports
  * "cli" — a logged-in Claude Code CLI (Max plan subscription) on this machine

Env (via /etc/rabit-brain.env):
  ANTHROPIC_API_KEY  use the metered API instead of the Max-plan CLI
  RABIT_MODEL        model id for API mode (default claude-opus-5)
  RABIT_PORT         listen port (default 8787)
  RABIT_RATE         max chat requests per hour per IP (default 60)
  RABIT_CLAUDE_BIN   explicit path to the claude CLI binary
"""
import glob
import json
import os
import re
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _int_env(name, default):
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


PORT = _int_env("RABIT_PORT", 8787)
MODEL = os.environ.get("RABIT_MODEL", "claude-opus-5")
RATE_LIMIT = _int_env("RABIT_RATE", 60)
API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
HOME = os.environ.get("HOME", "/root")

AGENT_KEYS = ["FE", "BE", "QA", "SEC", "DB", "AN", "UX", "MKT", "FIN"]

SYSTEM_PROMPT = """\
You are "RABIT AI CORE", the central intelligence of Rabit AI Company OS — \
the owner's personal AI company. You speak directly with the company owner \
(address them as "يا مدير" in Arabic or "boss" in English when it fits naturally).

The company has these AI employees, referenced by key:
FE frontend engineer, BE backend engineer, QA quality assurance, SEC security,
DB database engineer, AN data analyst, UX designer, MKT marketing, FIN finance.
(CEO approval and PM task assignment happen automatically — never include them.)

Always answer with a single JSON object: {"reply": "...", "team": [...]}
- reply: your answer in the SAME language the owner used (Arabic or English).
  Keep it to 1-3 short sentences because it is spoken aloud via text-to-speech.
  Confident, warm, practical. If the owner gives a work order, acknowledge it
  and mention which employees you assigned. If it's a question or small talk,
  just answer helpfully.
- team: the agent keys that should execute this order (pick only the relevant
  ones), or [] when the message is conversation/questions with nothing to execute."""

SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "team": {
            "type": "array",
            "items": {"type": "string", "enum": AGENT_KEYS},
        },
    },
    "required": ["reply", "team"],
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
    candidates = [
        os.environ.get("RABIT_CLAUDE_BIN"),
        shutil.which("claude"),
        "/usr/local/bin/claude",
        HOME + "/.local/bin/claude",
        HOME + "/.npm-global/bin/claude",
        "/usr/bin/claude",
        HOME + "/.claude/local/claude",
    ]
    # nvm installs live under versioned dirs systemd's PATH never sees
    candidates += sorted(glob.glob(HOME + "/.nvm/versions/node/*/bin/claude"),
                         reverse=True)
    for cand in candidates:
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            CLAUDE_BIN = cand
            break


def cli_logged_in():
    """Heuristic: the CLI keeps credentials/config under ~/.claude*."""
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
        return "claude CLI found but no login detected — run: claude login, then systemctl restart rabit-brain"
    if API_KEY:
        return "ANTHROPIC_API_KEY is set but the anthropic SDK is missing — pip3 install anthropic, then restart"
    return "set ANTHROPIC_API_KEY in /etc/rabit-brain.env or install+login the claude CLI, then restart"


# ---------------- state ----------------
sessions = {}          # sid -> [{"role","content"}, ...]
sessions_lock = threading.Lock()
hits = {}              # ip -> [timestamps]
hits_lock = threading.Lock()
cli_lock = threading.Lock()   # one Claude CLI process at a time


def allowed(ip):
    now = time.time()
    with hits_lock:
        if len(hits) > 5000:  # sweep idle IPs so the dict can't grow forever
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


def history_for(sid):
    with sessions_lock:
        return list(sessions.get(sid, []))


def remember(sid, user_msg, reply):
    with sessions_lock:
        h = sessions.setdefault(sid, [])
        h.append({"role": "user", "content": user_msg})
        h.append({"role": "assistant", "content": reply})
        del h[:-16]
        while len(sessions) > 500:
            sessions.pop(next(iter(sessions)))


def parse_brain_json(text):
    """Extract {"reply","team"} from model output; fall back to raw text."""
    m = re.search(r"\{.*\}", text.strip(), re.S)
    if m:
        try:
            data = json.loads(m.group(0))
            reply = str(data.get("reply", "")).strip()
            team = [k for k in data.get("team", []) if k in AGENT_KEYS]
            if reply:
                return reply, team
        except (json.JSONDecodeError, TypeError):
            pass
    return text.strip(), []


def ask_api(history, message):
    msgs = history + [{"role": "user", "content": message}]
    kwargs = dict(
        model=MODEL,
        max_tokens=2500,  # adaptive thinking shares this budget on claude-opus-5
        system=SYSTEM_PROMPT,
        messages=msgs,
        output_config={"effort": "low",
                       "format": {"type": "json_schema", "schema": SCHEMA}},
    )
    try:
        # server-side refusal fallback: a policy decline is re-served by the
        # recommended fallback model inside the same call
        resp = anthropic_client.beta.messages.create(
            betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs)
    except (TypeError, AttributeError):
        # SDK too old for the fallbacks beta; retry plain, then without
        # structured output as the last resort
        try:
            resp = anthropic_client.messages.create(**kwargs)
        except TypeError:
            kwargs.pop("output_config", None)
            resp = anthropic_client.messages.create(**kwargs)
    if resp.stop_reason == "refusal":
        return None, []
    if resp.stop_reason == "max_tokens":
        raise RuntimeError("brain reply was truncated (max_tokens)")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    reply, team = parse_brain_json(text)
    if not reply:
        raise RuntimeError("empty reply from brain")
    return reply, team


def ask_cli(history, message):
    convo = ""
    for turn in history:
        who = "Owner" if turn["role"] == "user" else "You"
        convo += "%s: %s\n" % (who, turn["content"])
    prompt = (SYSTEM_PROMPT
              + "\n\nRespond ONLY with the JSON object, nothing else."
              + "\n\nConversation so far:\n" + convo
              + "Owner: " + message + "\nYou:")
    env = dict(os.environ)
    env.setdefault("HOME", HOME)
    if not cli_lock.acquire(timeout=150):
        raise RuntimeError("brain is busy with another request — try again shortly")
    try:
        out = subprocess.run(
            [CLAUDE_BIN, "-p", prompt, "--output-format", "json"],
            capture_output=True, text=True, timeout=240,
            cwd=os.path.dirname(os.path.abspath(__file__)), env=env,
        )
    finally:
        cli_lock.release()
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout)[:400])
    try:
        result = json.loads(out.stdout)
        text = result.get("result", "") if isinstance(result, dict) else out.stdout
        text = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False)
    except json.JSONDecodeError:
        text = out.stdout
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    reply, team = parse_brain_json(text)
    if not reply:
        raise RuntimeError("empty reply from brain")
    return reply, team


class Handler(BaseHTTPRequestHandler):
    server_version = "RabitBrain/1.1"
    timeout = 30  # socket timeout: a stalled client can't pin a thread forever

    def log_message(self, fmt, *args):
        pass

    def _client_ip(self):
        """Real client IP. Trust proxy headers only from local nginx —
        install.sh makes nginx overwrite X-Real-IP, so it can't be spoofed."""
        peer = self.client_address[0]
        if peer in ("127.0.0.1", "::1"):
            real = self.headers.get("X-Real-IP", "").strip()
            if real:
                return real
            xff = self.headers.get("X-Forwarded-For", "")
            if xff:  # our nginx appends the real client last
                return xff.split(",")[-1].strip()
        return peer

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0].rstrip("/") == "/api/health":
            out = {"ok": True, "brain": brain_kind(), "model": MODEL}
            hint = brain_hint()
            if hint:
                out["hint"] = hint
            self._send(200, out)
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") != "/api/chat":
            self._send(404, {"error": "not found"})
            return
        if brain_kind() == "none":
            self._send(503, {"error": "no brain configured", "hint": brain_hint()})
            return
        if not allowed(self._client_ip()):
            self._send(429, {"reply": "وصلنا الحد الأقصى من الطلبات مؤقتًا — "
                                      "جرب بعد شوي يا مدير ⏳", "team": []})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > 65536:
            self._send(400, {"error": "bad request size"})
            return
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError, OSError):
            self._send(400, {"error": "bad json"})
            return
        if not isinstance(data, dict):
            self._send(400, {"error": "bad json"})
            return
        message = str(data.get("message", "")).strip()[:4000]
        lang = data.get("lang", "ar")
        sid = str(data.get("session", "anon"))[:64]
        if not message:
            self._send(400, {"error": "empty message"})
            return
        history = history_for(sid)
        try:
            if anthropic_client is not None:
                reply, team = ask_api(history, message)
            else:
                reply, team = ask_cli(history, message)
        except Exception as exc:  # surfaces as DEMO fallback in the dashboard
            self._send(502, {"error": ("brain error: %s" % exc)[:300]})
            return
        if reply is None:  # safety refusal
            reply = ("ما أقدر أساعد في هذا الطلب يا مدير." if lang == "ar"
                     else "I can't help with that request, boss.")
            team = []
        remember(sid, message, reply)
        self._send(200, {"reply": reply, "team": team})


if __name__ == "__main__":
    print("Rabit brain on 127.0.0.1:%d — brain=%s model=%s"
          % (PORT, brain_kind(), MODEL), flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
