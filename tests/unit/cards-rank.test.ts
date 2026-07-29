// Card ranking: action-required > severity > deadline > recency; max 4;
// dismissal is per entity+seq so a NEW event re-surfaces the card.
import { test } from 'node:test';
import assert from 'node:assert';
import { rankCards, dismissKey, MAX_CARDS } from '../../web/js/ui/cards-rank.js';

const card = (id: string, over: Record<string, unknown> = {}) => ({
  id, kind: 'x', actionRequired: false, severity: 0, seq: 1, ...over,
});

test('ordering: actionRequired, severity, deadline, recency', () => {
  const ranked = rankCards([
    card('info-old', { seq: 5 }),
    card('action', { actionRequired: true, severity: 1 }),
    card('severe', { severity: 3, seq: 2 }),
    card('deadline', { severity: 3, deadline: 100, seq: 1 }),
    card('info-new', { seq: 9 }),
  ]);
  assert.deepEqual(ranked.map((c: { id: string }) => c.id), ['action', 'deadline', 'severe', 'info-new']);
});

test('max 4 surface', () => {
  const many = Array.from({ length: 9 }, (_, i) => card(`c${i}`, { seq: i }));
  assert.equal(rankCards(many).length, MAX_CARDS);
});

test('dismissal hides the exact entity+seq; a new seq re-surfaces', () => {
  const c1 = card('approval:a1', { actionRequired: true, seq: 7 });
  const dismissed = new Set([dismissKey(c1)]);
  assert.equal(rankCards([c1], dismissed).length, 0);
  const c2 = { ...c1, seq: 8 }; // a new real event on the same entity
  assert.equal(rankCards([c2], dismissed).length, 1);
});
