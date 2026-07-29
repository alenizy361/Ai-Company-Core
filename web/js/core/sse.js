// Fetch-based SSE reader for /api/events. Unlike EventSource with named
// listeners, this sees EVERY event type — including ones added after this
// client shipped — and resumes from the last seen seq with backoff.
export class EventStream {
  constructor(url, { onEvent, onStatus, sinceProvider }) {
    this.url = url;
    this.onEvent = onEvent;       // ({seq, type, ...envelope}) => void
    this.onStatus = onStatus;     // ('connected'|'reconnecting'|'closed') => void
    this.sinceProvider = sinceProvider; // () => lastSeq
    this.stopped = false;
    this.backoffMs = 1000;
    this.connected = false;
  }

  start() {
    this.stopped = false;
    void this.loop();
  }

  stop() {
    this.stopped = true;
    this.abort?.abort();
  }

  async loop() {
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const since = this.sinceProvider?.() ?? 0;
        const res = await fetch(`${this.url}?since=${since}`, {
          signal: this.abort.signal,
          headers: { accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        this.connected = true;
        this.backoffMs = 1000;
        this.onStatus?.('connected');
        await this.consume(res.body);
      } catch { /* fall through to reconnect */ }
      this.connected = false;
      if (this.stopped) break;
      this.onStatus?.('reconnecting');
      await new Promise((r) => setTimeout(r, this.backoffMs));
      this.backoffMs = Math.min(this.backoffMs * 2, 15000);
    }
    this.onStatus?.('closed');
  }

  async consume(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue; // comment/ping frames
        try {
          this.onEvent(JSON.parse(data));
        } catch { /* malformed frame — skip */ }
      }
    }
  }
}
