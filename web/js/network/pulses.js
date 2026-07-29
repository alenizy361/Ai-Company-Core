// Event pulses: every pulse is born from a REAL persisted event (it carries
// the event seq); the travel animation is presentation-only and decays. Under
// reduced motion the edge/node gets a static highlight instead.
import { motionAllowed } from '../core/prefs.js';

const PULSE_MS = 1200;
const CAP = 24;

export class PulseLayer {
  constructor(svg) {
    this.group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    svg.appendChild(this.group);
    this.pulses = []; // {seq, type, pathEl, startAt, dot}
  }

  /** Spawn a pulse along an existing edge path element, tagged with the event. */
  spawn({ seq, type, pathEl }) {
    if (!pathEl || typeof pathEl.getTotalLength !== 'function') return;
    if (!motionAllowed()) {
      // Static highlight: mark the edge briefly via class (CSS, no animation).
      pathEl.classList.add('pulse-static');
      setTimeout(() => pathEl.classList.remove('pulse-static'), PULSE_MS);
      return;
    }
    if (this.pulses.length >= CAP) this.retire(this.pulses[0]);
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('r', '4');
    dot.setAttribute('class', `pulse ${type}`);
    dot.dataset.seq = String(seq);
    this.group.appendChild(dot);
    this.pulses.push({ seq, type, pathEl, startAt: performance.now(), dot });
  }

  retire(pulse) {
    pulse.dot.remove();
    const idx = this.pulses.indexOf(pulse);
    if (idx !== -1) this.pulses.splice(idx, 1);
  }

  /** Advance all pulses; call from the shared rAF loop. */
  step(now) {
    for (const pulse of [...this.pulses]) {
      const progress = (now - pulse.startAt) / PULSE_MS;
      if (progress >= 1 || !pulse.pathEl.isConnected) {
        this.retire(pulse);
        continue;
      }
      try {
        const len = pulse.pathEl.getTotalLength();
        const pt = pulse.pathEl.getPointAtLength(len * progress);
        pulse.dot.setAttribute('cx', String(pt.x));
        pulse.dot.setAttribute('cy', String(pt.y));
      } catch {
        this.retire(pulse);
      }
    }
  }

  get active() {
    return this.pulses.length;
  }
}
