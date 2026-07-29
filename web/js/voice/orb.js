// The audio-reactive core — ports the original Rabit nebula identity (stars,
// gradient sphere, rotating mesh) with every motion bound to REAL signals:
// input amplitude = live mic analyser; output amplitude = actually-playing
// synthesis; thinking shimmer only during a real model request; executing ring
// only when the backend reports running executions. No timers fake activity.
// Honors prefers-reduced-motion (static render, state color only).
const STATE_COLORS = {
  ready: '#38e1ff', wake_word_listening: '#38e1ff', listening: '#4ade80',
  detecting_end_of_turn: '#4ade80', transcribing: '#4ade80',
  thinking: '#b18cff', calling_tool: '#fbbf24', creating_plan: '#b18cff',
  executing: '#38e1ff', waiting_for_approval: '#fbbf24',
  generating_speech: '#b18cff', speaking: '#b18cff', interrupted: '#fbbf24',
  connecting: '#8b93c4', reconnecting: '#8b93c4', muted: '#64748b',
  offline: '#64748b', failed: '#fb7185', initializing: '#8b93c4', permission_required: '#fbbf24',
};

const MOVING_STATES = new Set([
  'ready', 'listening', 'detecting_end_of_turn', 'transcribing', 'thinking',
  'calling_tool', 'creating_plan', 'executing', 'generating_speech', 'speaking',
  'waiting_for_approval', 'wake_word_listening', 'interrupted',
]);

export class Orb {
  constructor(canvas, getSignals) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.getSignals = getSignals; // () => ({state, amplitude, executing, approvals})
    this.t = 0;
    this.stars = [];
    this.mesh = [];
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
    this.R = Math.min(this.W * 0.24, this.H * 0.32);
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

  draw() {
    const { ctx, W, H, CX, CY, dpr } = this;
    const { state, amplitude, executing, approvals } = this.getSignals();
    const color = STATE_COLORS[state] ?? '#8b93c4';
    const moving = !this.reducedMotion && MOVING_STATES.has(state);

    if (moving) this.t += state === 'thinking' || state === 'creating_plan' ? 0.02 : 0.008;
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

    // Nebula gradients (the original identity).
    let g = ctx.createRadialGradient(CX, CY, 0, CX, CY, r * 1.9);
    g.addColorStop(0, 'rgba(216,180,254,0.5)');
    g.addColorStop(0.35, 'rgba(168,85,247,0.3)');
    g.addColorStop(0.62, color + '22');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(CX, CY, r * 1.9, 0, 7); ctx.fill();

    g = ctx.createRadialGradient(CX - r * 0.3, CY - r * 0.25, 0, CX, CY, r);
    g.addColorStop(0, 'rgba(244,214,255,0.85)');
    g.addColorStop(0.45, 'rgba(147,90,235,0.55)');
    g.addColorStop(0.8, 'rgba(23,37,84,0.9)');
    g.addColorStop(1, 'rgba(10,15,35,0.95)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(CX, CY, r, 0, 7); ctx.fill();

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

    // Approval ring: a real pending approval shows a dashed outer ring.
    if (approvals > 0) {
      ctx.setLineDash([8 * dpr, 6 * dpr]);
      ctx.strokeStyle = '#fbbf24';
      ctx.beginPath(); ctx.arc(CX, CY, r * 1.18, 0, 7); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;

    // Labels: identity + real execution count only.
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(255,255,255,.7)';
    ctx.shadowBlur = 12 * dpr;
    ctx.font = `800 ${r * 0.28}px -apple-system,Segoe UI,Arial`;
    ctx.fillText('RABIT', CX, CY - r * 0.02);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#dfe7ff';
    ctx.font = `700 ${r * 0.11}px -apple-system,Segoe UI,Arial`;
    if (executing > 0) ctx.fillText(`${executing} task${executing > 1 ? 's' : ''} running`, CX, CY + r * 0.24);

    requestAnimationFrame(() => this.draw());
  }
}
