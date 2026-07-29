// Pure layout: places active agents on a ring around the SIRA core,
// preserving the designed board arrangement (config/agents.json board{x,y}
// percentages; CEO top). Inactive agents collapse to dots on a dim outer arc.
// Unit-tested in tests/unit/network-layout.test.ts (DOM-free).

const MIN_SEPARATION = 0.35; // radians between adjacent active nodes

export function angleFor(board) {
  // Screen coords: y grows downward; board {50, 7.5} (CEO) must point up.
  return Math.atan2((board?.y ?? 50) - 50, (board?.x ?? 50) - 50);
}

/** Spread angles apart so labels never collide (≤13 nodes; iterative relax). */
export function separate(angles) {
  const indexed = angles.map((a, i) => ({ a, i })).sort((p, q) => p.a - q.a);
  for (let pass = 0; pass < 24; pass++) {
    let moved = false;
    for (let k = 0; k < indexed.length; k++) {
      const cur = indexed[k];
      const next = indexed[(k + 1) % indexed.length];
      let gap = next.a - cur.a;
      if (k === indexed.length - 1) gap += Math.PI * 2;
      if (gap < MIN_SEPARATION && indexed.length > 1) {
        const push = (MIN_SEPARATION - gap) / 2;
        cur.a -= push;
        next.a += push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const out = new Array(angles.length);
  for (const { a, i } of indexed) out[i] = a;
  return out;
}

/**
 * @param input {{ agents: Array<{key:string, board?:{x:number,y:number}}>,
 *                 activeKeys: Set<string>, width: number, height: number }}
 * @returns {{ cx, cy, ringR, nodes: Array<{key,x,y}>, dots: Array<{key,x,y}> }}
 */
export function layoutNetwork({ agents, activeKeys, width, height }) {
  const cx = width / 2;
  const cy = height / 2;
  const ringR = Math.min(width, height) * 0.38;
  const dotR = Math.min(width, height) * 0.475;

  const active = agents.filter((a) => activeKeys.has(a.key));
  const inactive = agents.filter((a) => !activeKeys.has(a.key));

  const angles = separate(active.map((a) => angleFor(a.board)));
  const nodes = active.map((a, i) => ({
    key: a.key,
    x: cx + Math.cos(angles[i]) * ringR,
    y: cy + Math.sin(angles[i]) * ringR,
  }));

  const dots = inactive.map((a, i) => {
    const angle = -Math.PI / 2 + ((i + 1) / (inactive.length + 1)) * Math.PI * 2;
    return { key: a.key, x: cx + Math.cos(angle) * dotR, y: cy + Math.sin(angle) * dotR };
  });

  return { cx, cy, ringR, nodes, dots };
}
