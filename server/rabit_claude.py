"""Shared Claude Code CLI helpers for the Rabit brain and worker.

Two entry points:
  chat(bin, system, history, message, home)  -> str   (one-shot JSON reply)
  run_job(bin, spec, workdir, home, max_turns) -> (ok, log)  (tool-enabled build)

Both invoke the locally logged-in `claude` binary (Max plan). chat() serializes
via a module lock so concurrent web requests don't fork many processes; the
worker runs jobs one at a time by its own design.
"""
import json
import os
import re
import signal
import subprocess
import threading

_chat_lock = threading.Lock()


def chat(claude_bin, system, history, message, home):
    convo = ""
    for turn in history:
        who = "Owner" if turn["role"] == "user" else "You"
        convo += "%s: %s\n" % (who, turn["content"])
    prompt = (system
              + "\n\nRespond ONLY with the JSON object, nothing else."
              + "\n\nConversation so far:\n" + convo
              + "Owner: " + message + "\nYou:")
    env = dict(os.environ)
    env.setdefault("HOME", home)
    if not _chat_lock.acquire(timeout=150):
        raise RuntimeError("brain is busy — try again shortly")
    try:
        out = subprocess.run([claude_bin, "-p", prompt, "--output-format", "json"],
                             capture_output=True, text=True, timeout=240,
                             cwd=os.path.dirname(os.path.abspath(__file__)), env=env)
    finally:
        _chat_lock.release()
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout)[:400])
    try:
        r = json.loads(out.stdout)
        text = r.get("result", "") if isinstance(r, dict) else out.stdout
        text = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False)
    except json.JSONDecodeError:
        text = out.stdout
    return re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())


def run_job(claude_bin, spec, workdir, home, max_turns=40, timeout=1800,
            should_abort=None, role="", brief="", arabic=False):
    """Run a tool-enabled build in `workdir`. File tools only — NO Bash, no
    internet — so the blast radius is the workspace directory.

    role/brief carry WHO this step is and WHERE it sits in the project. Without
    them every step ran as the same anonymous builder that could not see the
    goal, which is what made a specialist's output read as generic.

    should_abort: optional callable polled every few seconds; when it returns
    True the claude process group is killed and the job reports cancellation.
    Returns (ok: bool, log: str). A cancelled job returns (False, "cancelled").
    """
    os.makedirs(workdir, exist_ok=True)
    prompt = "You are %s\n\n" % (role or "an autonomous builder.")
    if brief:
        prompt += brief + "\n\n"
    prompt += (
        "You work inside a sandbox directory with NO internet access and NO "
        "shell. Using only file tools (Read, Write, Edit), produce your part as "
        "real files in the current directory.\n\n"
        "HOW TO WORK:\n"
        "- Read what earlier steps produced BEFORE writing. Build on it; never "
        "restate it and never start over.\n"
        "- Finish the whole job. Placeholders, TODOs, lorem ipsum and 'add your "
        "content here' are failures, not drafts.\n"
        "- Prefer one self-contained index.html for a web page or site (inline "
        "CSS/JS, no external requests, no external images).\n"
        "- Write a short README.md saying what you produced and what you decided.\n"
        "- Do not ask questions — make reasonable choices and finish.\n")
    if arabic:
        prompt += ("- The owner is Arabic. All content a person reads must be in "
                   "Arabic, and any web page must set lang=\"ar\" dir=\"rtl\".\n")
    prompt += "\nYOUR TASK:\n" + spec
    env = dict(os.environ)
    env.setdefault("HOME", home)
    cmd = [claude_bin, "-p", prompt,
           "--allowedTools", "Read,Write,Edit",
           "--permission-mode", "acceptEdits",
           "--max-turns", str(max_turns),
           "--output-format", "json"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, cwd=workdir, env=env,
                            start_new_session=True)  # own group so we can kill the tree

    def _kill():
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except OSError:
                pass

    waited = 0.0
    while True:
        try:
            out, err = proc.communicate(timeout=3)
            break
        except subprocess.TimeoutExpired:
            waited += 3
            if should_abort is not None and should_abort():
                _kill()
                try:
                    proc.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
                return False, "cancelled"
            if waited >= timeout:
                _kill()
                try:
                    proc.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
                return False, "job timed out after %ds" % timeout
    log = (out or "") + "\n" + (err or "")
    return proc.returncode == 0, log[-4000:]
