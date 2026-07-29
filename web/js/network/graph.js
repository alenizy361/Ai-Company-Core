// Neural agent network renderer (SVG). Every node is a real agent from
// /api/state; every edge is a real relation (assignment from in-flight
// tasks, dependency from task_dependencies, handoff from handoff.created);
// every pulse carries a real event seq. Nothing decorative moves.
import { layoutNetwork } from './layout.js';
import { PulseLayer } from './pulses.js';
import { t } from '../i18n/i18n.js';

const SVG = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  return node;
}

export class NetworkGraph {
  constructor(svg, { backend, onSelect }) {
    this.svg = svg;
    this.backend = backend;
    this.onSelect = onSelect;
    this.edgeGroup = svgEl('g');
    this.nodeGroup = svgEl('g');
    svg.appendChild(this.edgeGroup);
    svg.appendChild(this.nodeGroup);
    this.pulseLayer = new PulseLayer(svg);
    this.edgePaths = new Map(); // edgeId -> {pathEl, meta}
    this.nodePos = new Map();
    this.dag = null;
    this.dagObjectiveId = null;
    this.resize();
    addEventListener('resize', () => {
      this.resize();
      void this.render();
    });

    // Real event -> pulse mapping (each pulse tagged with the event seq).
    backend.on('task.status', (ev) => {
      if (ev.payload?.source === 'worker_claim' && ev.agentKey) {
        this.pulse(`core:${ev.agentKey}`, 'assignment', ev.seq);
      }
    });
    backend.on('tool.started', (ev) => {
      if (ev.agentKey) this.pulse(`core:${ev.agentKey}`, 'tool', ev.seq);
    });
    backend.on('artifact.created', (ev) => {
      if (ev.agentKey) this.pulse(`core:${ev.agentKey}`, 'artifact', ev.seq);
    });
    backend.on('handoff.created', (ev) => {
      const from = ev.payload?.fromAgent;
      const to = ev.payload?.toAgent;
      if (from && to) this.pulse(`dep:${from}:${to}`, 'handoff', ev.seq, `core:${to}`);
    });
    backend.on('execution.verifying', (ev) => {
      if (ev.agentKey) this.pulse(`core:${ev.agentKey}`, 'verification', ev.seq);
    });
  }

  resize() {
    const parent = this.svg.parentElement;
    this.width = parent.clientWidth;
    this.height = parent.clientHeight;
    this.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
  }

  pulse(edgeId, type, seq, fallbackEdgeId) {
    const edge = this.edgePaths.get(edgeId) ?? (fallbackEdgeId ? this.edgePaths.get(fallbackEdgeId) : null);
    if (edge) this.pulseLayer.spawn({ seq, type, pathEl: edge.pathEl });
  }

  step(now) {
    this.pulseLayer.step(now);
  }

  /** Full re-render from current backend truth (cheap at ≤13 nodes). */
  async render() {
    const s = this.backend.snapshot;
    if (!s) return;
    const agents = s.agents ?? [];

    // Active = has an in-flight task (status derived from real task rows).
    const IN_FLIGHT = new Set(['queued', 'running', 'waiting_for_tool', 'waiting_for_approval', 'verifying', 'waiting_for_dependency', 'blocked']);
    const activeKeys = new Set(agents.filter((a) => IN_FLIGHT.has(a.status) && a.taskId).map((a) => a.key));

    // Load the active objective's DAG for dependency edges.
    let dag = null;
    const objective = this.backend.activeObjective();
    if (objective) {
      try {
        dag = await this.backend.objectiveDetail(objective.id);
        for (const task of dag.tasks ?? []) {
          if (IN_FLIGHT.has(task.status)) activeKeys.add(task.agent_key);
        }
      } catch { /* detail unavailable — snapshot-only view */ }
    }
    this.dag = dag;

    const layout = layoutNetwork({ agents, activeKeys, width: this.width, height: this.height });
    this.nodePos = new Map(layout.nodes.map((n) => [n.key, n]));
    this.edgeGroup.textContent = '';
    this.nodeGroup.textContent = '';
    this.edgePaths.clear();

    const addEdge = (id, x1, y1, x2, y2, cls, meta) => {
      if (this.edgePaths.has(id)) return;
      const d = `M ${x1} ${y1} L ${x2} ${y2}`;
      const hit = svgEl('path', { d, class: 'edge-hit', tabindex: '0', role: 'button', 'aria-label': meta.label });
      const path = svgEl('path', { d, class: `edge ${cls}` });
      hit.addEventListener('click', () => this.onSelect?.({ kind: 'edge', ...meta }));
      hit.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.onSelect?.({ kind: 'edge', ...meta });
        }
      });
      this.edgeGroup.appendChild(hit);
      this.edgeGroup.appendChild(path);
      this.edgePaths.set(id, { pathEl: path, meta });
    };

    // Assignment edges: core -> each active agent (real in-flight task).
    for (const node of layout.nodes) {
      const agent = agents.find((a) => a.key === node.key);
      addEdge(`core:${node.key}`, layout.cx, layout.cy, node.x, node.y, 'assignment', {
        type: 'assignment',
        label: `${t('network.edge.assignment')}: ${node.key}`,
        agentKey: node.key,
        taskId: agent?.taskId ?? null,
      });
    }

    // Dependency edges between agents of the active plan (real task_dependencies).
    if (dag) {
      const taskAgent = new Map((dag.tasks ?? []).map((task) => [task.id, task.agent_key]));
      for (const dep of dag.dependencies ?? []) {
        const fromAgent = taskAgent.get(dep.depends_on_task_id);
        const toAgent = taskAgent.get(dep.task_id);
        const a = this.nodePos.get(fromAgent);
        const b = this.nodePos.get(toAgent);
        if (a && b && fromAgent !== toAgent) {
          addEdge(`dep:${fromAgent}:${toAgent}`, a.x, a.y, b.x, b.y, 'dependency', {
            type: 'dependency',
            label: `${t('network.edge.dependency')}: ${fromAgent} → ${toAgent}`,
            fromAgent, toAgent,
            taskId: dep.task_id,
            dependsOnTaskId: dep.depends_on_task_id,
          });
        }
      }
    }

    // Core node.
    const core = svgEl('g', { class: 'node core', role: 'button', tabindex: '0', 'aria-label': t('network.core') });
    core.appendChild(svgEl('circle', { class: 'corehit', cx: layout.cx, cy: layout.cy, r: 40, fill: 'transparent' }));
    core.addEventListener('click', () => this.onSelect?.({ kind: 'core' }));
    this.nodeGroup.appendChild(core);

    // Agent nodes (focus order = clockwise from the layout).
    for (const node of layout.nodes) {
      const agent = agents.find((a) => a.key === node.key);
      if (!agent) continue;
      const label = document.documentElement.lang === 'ar' ? agent.nameAr : agent.nameEn;
      const g = svgEl('g', {
        class: `node ${agent.status}`, role: 'button', tabindex: '0',
        'aria-label': t('network.node', { name: label, status: t(`state.${agent.status}`, {}) === `state.${agent.status}` ? agent.status : t(`state.${agent.status}`) }),
      });
      g.appendChild(svgEl('circle', { class: 'body', cx: node.x, cy: node.y, r: 24, fill: agent.color ? `${agent.color}22` : undefined }));
      const shortText = svgEl('text', { class: 'short', x: node.x, y: node.y + 4 });
      shortText.textContent = agent.short;
      g.appendChild(shortText);
      const statusText = svgEl('text', { class: 'status', x: node.x, y: node.y + 38 });
      statusText.textContent = agent.status;
      g.appendChild(statusText);
      const select = () => this.onSelect?.({ kind: 'agent', key: agent.key, taskId: agent.taskId });
      g.addEventListener('click', select);
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
        }
      });
      this.nodeGroup.appendChild(g);
    }

    // Inactive agents as minimized dots (hidden <768px via CSS).
    for (const dot of layout.dots) {
      const agent = agents.find((a) => a.key === dot.key);
      if (!agent) continue;
      const g = svgEl('g', {
        class: 'minidot', role: 'button', tabindex: '0',
        'aria-label': `${agent.nameEn} — ${t('network.idle')}`,
      });
      g.appendChild(svgEl('circle', { cx: dot.x, cy: dot.y, r: 4 }));
      g.addEventListener('click', () => this.onSelect?.({ kind: 'agent', key: agent.key, taskId: null }));
      this.nodeGroup.appendChild(g);
    }
  }
}
