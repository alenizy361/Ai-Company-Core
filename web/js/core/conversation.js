// Single conversation store shared by voice and chat — one history, two
// input modalities. Live turns append locally; resync() replaces state from
// the persisted record (the honest recovery after any stream interruption).
import { prefs } from './prefs.js';

export class ConversationStore {
  constructor() {
    this.id = prefs.get('conversationId') || null;
    this.messages = []; // {id?, role, content, tech?, streaming?}
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify() {
    for (const fn of this.listeners) fn(this);
  }

  setId(id) {
    if (id && id !== this.id) {
      this.id = id;
      prefs.set('conversationId', id);
    }
  }

  addUser(text) {
    this.messages.push({ role: 'user', content: text });
    this._notify();
  }

  /** Begin a streaming assistant turn; returns an updater(fullText). */
  beginAssistant() {
    const msg = { role: 'assistant', content: '', streaming: true };
    this.messages.push(msg);
    this._notify();
    return (fullText, { done } = {}) => {
      msg.content = fullText;
      if (done) msg.streaming = false;
      this._notify();
    };
  }

  addSystem(text, techNote) {
    this.messages.push({ role: 'system_note', content: text, tech: techNote });
    this._notify();
  }

  /** A COMPLETE assistant message that was generated entirely server-side
   * (e.g. the Background Objective Completion Bridge's final synthesis) —
   * no streaming needed, the text already exists in full. `id` lets a
   * caller de-duplicate against a later resync() of the same row. */
  addAssistant(text, { id } = {}) {
    if (id && this.messages.some((m) => m.id === id)) return; // already shown (event replay / resync race)
    this.messages.push({ id, role: 'assistant', content: text });
    this._notify();
  }

  /** Replace local state from the persisted record. */
  async resync() {
    if (!this.id) return;
    try {
      const rows = await (await fetch(`/api/conversations/${this.id}`)).json();
      if (Array.isArray(rows)) {
        this.messages = rows
          .filter((r) => r.role === 'user' || r.role === 'assistant')
          .map((r) => ({ id: r.id, role: r.role, content: r.content }));
        this._notify();
      }
    } catch { /* backend unreachable — local view stays */ }
  }
}
