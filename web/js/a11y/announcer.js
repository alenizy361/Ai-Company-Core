// Batched screen-reader announcements: meaningful states only, joined and
// flushed on an interval so token streams never spam the live region.
import { el } from '../core/dom.js';

const FLUSH_MS = 1500;

class Announcer {
  constructor() {
    this.region = el('div', { 'aria-live': 'polite', 'aria-atomic': 'true', class: 'sr-only' });
    document.body.appendChild(this.region);
    this.queue = [];
    this.timer = null;
    this.last = '';
  }

  say(text) {
    if (!text || text === this.last) return;
    this.last = text;
    this.queue.push(text);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.region.textContent = this.queue.join('; ');
        this.queue = [];
        this.timer = null;
      }, FLUSH_MS);
    }
  }
}

export const announcer = new Announcer();
