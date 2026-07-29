// Neural network layout: board-seeded polar placement (CEO top), minimum
// angular separation, active/inactive partition. Pure module.
import { test } from 'node:test';
import assert from 'node:assert';
import { layoutNetwork, angleFor, separate } from '../../web/js/network/layout.js';

test('CEO board seed {50, 7.5} points up', () => {
  const angle = angleFor({ x: 50, y: 7.5 });
  assert.ok(Math.abs(angle - -Math.PI / 2) < 0.01);
});

test('active agents ring, inactive agents dot arc, ids preserved', () => {
  const agents = [
    { key: 'ceo', board: { x: 50, y: 7.5 } },
    { key: 'backend', board: { x: 20, y: 60 } },
    { key: 'qa', board: { x: 80, y: 60 } },
    { key: 'finance', board: { x: 50, y: 90 } },
  ];
  const layout = layoutNetwork({ agents, activeKeys: new Set(['ceo', 'backend']), width: 1000, height: 800 });
  assert.deepEqual(layout.nodes.map((n) => n.key).sort(), ['backend', 'ceo']);
  assert.deepEqual(layout.dots.map((d) => d.key).sort(), ['finance', 'qa']);
  for (const node of layout.nodes) {
    const dist = Math.hypot(node.x - layout.cx, node.y - layout.cy);
    assert.ok(Math.abs(dist - layout.ringR) < 1, 'nodes sit on the ring');
  }
});

test('minimum angular separation is enforced', () => {
  const clustered = [0, 0.05, 0.1, 0.12];
  const spread = separate(clustered);
  const sorted = [...spread].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i] - sorted[i - 1] >= 0.3, `gap ${i} too small: ${sorted[i] - sorted[i - 1]}`);
  }
});
