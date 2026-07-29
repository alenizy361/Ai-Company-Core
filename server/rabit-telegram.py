#!/usr/bin/env python3
"""Rabit Telegram bridge — the owner talks to (and is reached by) the brain
from his phone, even when the dashboard is closed.

Long-polls the Telegram Bot API (needs no inbound TLS), accepts messages ONLY
from the configured owner chat_id, forwards them to the local brain
(127.0.0.1:$RABIT_PORT/api/chat with the owner bearer token), and sends the
reply back. Telegram voice-note dictation on the phone therefore works as a
voice interface regardless of the dashboard's HTTP mic limitation.

Env (from /etc/rabit-brain.env): TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, RABIT_TOKEN,
RABIT_PORT.
"""
import json
import os
import time
import urllib.request

TOKEN = os.environ.get("TELEGRAM_TOKEN", "").strip()
CHAT_ID = str(os.environ.get("TELEGRAM_CHAT_ID", "")).strip()
RABIT_TOKEN = os.environ.get("RABIT_TOKEN", "").strip()
PORT = int(os.environ.get("RABIT_PORT", "8787"))
API = "https://api.telegram.org/bot%s/" % TOKEN


def tg(method, payload, timeout=70):
    req = urllib.request.Request(API + method, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def send(text):
    try:
        tg("sendMessage", {"chat_id": CHAT_ID, "text": text[:4000]}, timeout=20)
    except Exception:
        pass


def ask_brain(message):
    body = json.dumps({"message": message, "lang": "ar", "session": "owner"}).encode()
    req = urllib.request.Request("http://127.0.0.1:%d/api/chat" % PORT, data=body,
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + RABIT_TOKEN})
    with urllib.request.urlopen(req, timeout=240) as r:
        d = json.loads(r.read())
    reply = d.get("reply", "")
    order = d.get("order")
    if order:
        reply += ("\n\n[أمر جاهز للتنفيذ: %s — افتح اللوحة واضغط تنفيذ لتشغيله فعلياً]"
                  % order.get("title", ""))
    return reply or "..."


def main():
    if not (TOKEN and CHAT_ID and RABIT_TOKEN):
        print("telegram bridge disabled — set TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, RABIT_TOKEN",
              flush=True)
        while True:
            time.sleep(3600)
    print("Rabit telegram bridge up for chat_id=%s" % CHAT_ID, flush=True)
    offset = 0
    while True:
        try:
            upd = tg("getUpdates", {"offset": offset, "timeout": 60})
        except Exception:
            time.sleep(5); continue
        for u in upd.get("result", []):
            offset = u["update_id"] + 1
            msg = u.get("message") or {}
            if str(msg.get("chat", {}).get("id", "")) != CHAT_ID:
                continue  # ignore everyone except the owner
            text = (msg.get("text") or "").strip()
            if msg.get("voice") and not text:
                send("وصلتني رسالتك الصوتية — فعّل التفريغ الصوتي في تيليجرام أو اكتب لي نصاً "
                     "مؤقتاً يا مدير.")
                continue
            if not text:
                continue
            try:
                send(ask_brain(text))
            except Exception as exc:
                send("صار خطأ بالاتصال بالنواة: %s" % str(exc)[:200])


if __name__ == "__main__":
    main()
