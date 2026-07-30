// The SIRA Core — the audio-reactive center. Carries the nebula visual
// identity forward with every motion bound to REAL signals: input amplitude
// from the live mic analyser, output activity from actually-playing speech
// (real playback boundaries), executing ring from real running executions,
// approval ring from real pending approvals. No timers fake activity.
import { motionAllowed } from '../core/prefs.js';

const STATE_COLORS = {
  ready: '#22d3ee', wake_word_listening: '#22d3ee', listening: '#4ade80',
  detecting_end_of_turn: '#4ade80', transcribing: '#4ade80',
  thinking: '#a78bfa', routing: '#a78bfa', calling_tool: '#facc15', creating_plan: '#a78bfa',
  connecting_agents: '#22d3ee', executing: '#22d3ee', using_tool: '#facc15',
  receiving_handoff: '#a78bfa', verifying: '#4ade80', waiting_for_approval: '#facc15',
  generating_speech: '#a78bfa', generating_response: '#a78bfa', speaking: '#a78bfa',
  interrupted: '#facc15', connecting: '#7ab0ff', reconnecting: '#7ab0ff', muted: '#64748b',
  offline: '#64748b', sync_lost: '#f87171', failed: '#f87171',
  initializing: '#7ab0ff', permission_required: '#facc15',
};

const MOVING_STATES = new Set([
  'ready', 'listening', 'detecting_end_of_turn', 'transcribing', 'thinking', 'routing',
  'calling_tool', 'creating_plan', 'connecting_agents', 'executing', 'using_tool',
  'receiving_handoff', 'verifying', 'generating_speech', 'generating_response', 'speaking',
  'waiting_for_approval', 'wake_word_listening', 'interrupted',
]);

export class SiraCore {
  constructor(canvas, getSignals) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.getSignals = getSignals; // () => ({state, amplitude, executing, approvals})
    this.t = 0;
    this.stars = [];
    this.mesh = [];
    this.resize();
    addEventListener('resize', () => this.resize());
    requestAnimationFrame(() => this.draw());
  }

  resize() {
    const parent = this.cv.parentElement;
    const dpr = devicePixelRatio || 1;
    this.W = this.cv.width = parent.clientWidth * dpr;
    this.H = this.cv.height = parent.clientHeight * dpr;
    this.cv.style.width = parent.clientWidth + 'px';
    this.cv.style.height = parent.clientHeight + 'px';
    this.CX = this.W / 2;
    this.CY = this.H * 0.5;
    this.R = Math.min(this.W * 0.2, this.H * 0.26);
    this.stars = [];
    for (let i = 0; i < 90; i++) {
      this.stars.push({ x: Math.random() * this.W, y: Math.random() * this.H, r: Math.random() * 1.3 * dpr, tw: Math.random() * 7 });
    }
    this.mesh = [];
    for (let i = 0; i < 48; i++) {
      this.mesh.push({ th: Math.acos(2 * Math.random() - 1), ph: Math.random() * Math.PI * 2 });
    }
    this.dpr = dpr;
  }

  /** Three concentric rings around the core, sized off the current radius.
   *  Solid, not dashed: a rotating featureless circle looks identical to a
   *  static one, so there's nothing honest to animate here — these are pure
   *  static framing, like a bezel. */
  decoRings(r) {
    return [
      { radius: r * 1.3, color: '#7c3aed', alpha: 0.55, width: 1.5 },
      { radius: r * 1.5, color: '#22d3ee', alpha: 0.4, width: 1.2 },
      { radius: r * 1.68, color: '#a78bfa', alpha: 0.45, width: 1 },
    ];
  }

  draw() {
    requestAnimationFrame(() => this.draw());
    if (document.hidden) return;
    const { ctx, W, H, CX, CY, dpr } = this;
    const { state, amplitude, executing, approvals } = this.getSignals();
    const color = STATE_COLORS[state] ?? '#7ab0ff';
    const moving = motionAllowed() && MOVING_STATES.has(state);

    if (moving) this.t += ['thinking', 'creating_plan', 'routing'].includes(state) ? 0.02 : 0.008;
    ctx.clearRect(0, 0, W, H);

    for (const s of this.stars) {
      if (moving) s.tw += 0.02;
      ctx.globalAlpha = 0.2 + 0.25 * Math.sin(s.tw);
      ctx.fillStyle = '#9fb4ff';
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Radius: calm breathing at ready; REAL amplitude while listening/speaking.
    const breathe = moving && state === 'ready' ? Math.sin(this.t * 2) * 0.02 : 0;
    const r = this.R * (1 + breathe + amplitude * 0.22);

    let g = ctx.createRadialGradient(CX, CY, 0, CX, CY, r * 1.9);
    g.addColorStop(0, 'rgba(167,139,250,0.5)');
    g.addColorStop(0.35, 'rgba(124,58,237,0.3)');
    g.addColorStop(0.62, color + '22');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(CX, CY, r * 1.9, 0, 7); ctx.fill();

    g = ctx.createRadialGradient(CX - r * 0.3, CY - r * 0.25, 0, CX, CY, r);
    g.addColorStop(0, 'rgba(196,181,253,0.9)');
    g.addColorStop(0.45, 'rgba(124,58,237,0.65)');
    g.addColorStop(0.8, 'rgba(30,27,75,0.9)');
    g.addColorStop(1, 'rgba(10,15,35,0.95)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(CX, CY, r, 0, 7); ctx.fill();

    // Three decorative concentric rings — purely ambient framing (like a
    // clock's bezel), never implying data of their own.
    for (const ring of this.decoRings(r)) {
      ctx.strokeStyle = ring.color;
      ctx.globalAlpha = ring.alpha;
      ctx.lineWidth = ring.width * dpr;
      ctx.beginPath(); ctx.arc(CX, CY, ring.radius, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Inner mesh rotates only while genuinely active.
    const proj = [];
    for (const p of this.mesh) {
      const ph = p.ph + this.t;
      proj.push({
        x: CX + Math.sin(p.th) * Math.cos(ph) * r * 0.92,
        y: CY + Math.cos(p.th) * r * 0.86,
        z: Math.sin(p.th) * Math.sin(ph),
      });
    }
    ctx.strokeStyle = 'rgba(200,215,255,0.5)';
    ctx.lineWidth = 0.8 * dpr;
    for (let i = 0; i < proj.length; i++) {
      for (let j = i + 1; j < proj.length; j++) {
        const a = proj[i]; const b = proj[j];
        const dx = a.x - b.x; const dy = a.y - b.y;
        if (dx * dx + dy * dy < r * r * 0.3) {
          ctx.globalAlpha = 0.06 + 0.12 * ((a.z + b.z) / 2 + 1) / 2;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;

    // State ring.
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1.6 * dpr;
    ctx.beginPath(); ctx.arc(CX, CY, r, 0, 7); ctx.stroke();

    // Approval ring: only a REAL pending approval shows it.
    if (approvals > 0) {
      ctx.setLineDash([8 * dpr, 6 * dpr]);
      ctx.strokeStyle = '#facc15';
      ctx.beginPath(); ctx.arc(CX, CY, r * 1.18, 0, 7); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;

    // Identity + real execution count only.
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(255,255,255,.7)';
    ctx.shadowBlur = 12 * dpr;
    ctx.font = `800 ${r * 0.3}px -apple-system,Segoe UI,Arial`;
    ctx.fillText('SIRA', CX, CY + r * 0.06);
    ctx.shadowBlur = 0;
    if (executing > 0) {
      ctx.fillStyle = '#dfe7ff';
      ctx.font = `700 ${r * 0.11}px -apple-system,Segoe UI,Arial`;
      ctx.fillText(String(executing), CX, CY + r * 0.32);
    }
  }
}
