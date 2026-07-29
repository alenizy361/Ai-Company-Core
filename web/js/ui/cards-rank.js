// Pure card ranking: action-required first, then severity, deadline,
// recency (event seq), relevance. Max 4 surface. DOM-free — unit-tested.
export const MAX_CARDS = 4;

/**
 * @param cards Array<{
 *   id: string,            // stable identity: kind + entity id
 *   kind: string,
 *   actionRequired: boolean,
 *   severity: number,      // 0..3
 *   deadline?: number|null,
 *   seq: number,           // newest related event seq (recency)
 *   relevance?: number,    // 0..1
 * }>
 * @param dismissed Set<string> of `${id}@${seq}` keys — a NEW event on the
 *   same entity (higher seq) re-surfaces a dismissed card.
 */
export function rankCards(cards, dismissed = new Set()) {
  return cards
    .filter((c) => !dismissed.has(`${c.id}@${c.seq}`))
    .sort((a, b) =>
      Number(b.actionRequired) - Number(a.actionRequired)
      || b.severity - a.severity
      || (a.deadline ?? Infinity) - (b.deadline ?? Infinity)
      || b.seq - a.seq
      || (b.relevance ?? 0) - (a.relevance ?? 0))
    .slice(0, MAX_CARDS);
}

export function dismissKey(card) {
  return `${card.id}@${card.seq}`;
}
