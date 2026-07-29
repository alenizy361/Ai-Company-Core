// Context card rail: at most 4 ranked cards, every one backed by a real
// entity, every one explaining WHY it surfaced, with safe dismissal
// (a new event on the same entity re-surfaces it).
import { el, mount, tech, prose } from '../core/dom.js';
import { t, fmtNumber, locale } from '../i18n/i18n.js';
import { rankCards, dismissKey } from './cards-rank.js';
import { registerRegion } from './shell.js';

function loadDismissed() {
  try { return new Set(JSON.parse(sessionStorage.getItem('sira.dismissed') ?? '[]')); } catch { return new Set(); }
}
function saveDismissed(set) {
  try { sessionStorage.setItem('sira.dismissed', JSON.stringify([...set].slice(-100))); } catch { /* stateless */ }
}

export function buildCards({ backend, langOffer, onAction, onInspect }) {
  const rail = document.getElementById('cards');
  const dismissed = loadDismissed();
  let latest = [];

  function lastSeqOf(pred) {
    for (let i = backend.ring.length - 1; i >= 0; i--) {
      if (pred(backend.ring[i])) return backend.ring[i].seq ?? 0;
    }
    return 0;
  }

  async function collect() {
    const s = backend.snapshot;
    if (!s) return [];
    const cards = [];

    // Pending approvals (action required, severity high).
    if (s.pendingApprovals > 0) {
      try {
        const approvals = await (await fetch('/api/approvals?status=pending')).json();
        for (const a of approvals.slice(0, 2)) {
          cards.push({
            id: `approval:${a.id}`, kind: 'approval', actionRequired: true, severity: 3,
            seq: lastSeqOf((e) => e.type === 'approval.requested' && e.payload?.approvalId === a.id) || 1,
            title: t('card.approval.title'), body: a.summary, why: t('card.approval.why'),
            actions: [
              { label: `✓ ${t('action.approve')}`, cls: 'ok', post: [`/api/approvals/${a.id}/decide`, { decision: 'approved', via: 'ui' }] },
              { label: `✗ ${t('action.reject')}`, cls: 'danger', post: [`/api/approvals/${a.id}/decide`, { decision: 'rejected', via: 'ui' }] },
            ],
          });
        }
      } catch { /* endpoint unreachable — approvals stay in activity */ }
    }

    // Proposed plans (action required).
    for (const objective of s.objectives.filter((o) => o.status === 'plan_proposed').slice(0, 2)) {
      try {
        const detail = await backend.objectiveDetail(objective.id);
        for (const plan of (detail.plans ?? []).filter((p) => p.status === 'proposed').slice(0, 1)) {
          cards.push({
            id: `plan:${plan.id}`, kind: 'plan', actionRequired: true, severity: 2,
            seq: lastSeqOf((e) => e.type === 'plan.proposed' && e.payload?.planId === plan.id) || 1,
            title: t('card.plan.title'), body: `${objective.title} — ${plan.reply ?? ''}`, why: t('card.plan.why'),
            actions: [
              { label: `✓ ${t('action.confirm')}`, cls: 'ok', post: [`/api/plans/${plan.id}/confirm`, {}] },
              { label: `✗ ${t('action.reject')}`, cls: 'danger', post: [`/api/plans/${plan.id}/reject`, { reason: 'rejected from card' }] },
            ],
          });
        }
      } catch { /* skip */ }
    }

    // Failures with retry (action required).
    try {
      const failures = await (await fetch('/api/failures')).json();
      for (const task of (failures.failedTasks ?? []).slice(0, 1)) {
        cards.push({
          id: `failure:${task.id}`, kind: 'failure', actionRequired: true, severity: 3,
          seq: lastSeqOf((e) => e.taskId === task.id && e.type === 'task.status') || 1,
          title: t('card.failure.title'), body: task.title, whyDetail: task.blocker, why: t('card.failure.why'),
          actions: [
            { label: `↻ ${t('action.retry')}`, cls: '', post: [`/api/tasks/${task.id}/retry`, {}] },
            { label: t('action.details'), cls: '', inspect: { kind: 'task', id: task.id } },
          ],
        });
      }
    } catch { /* skip */ }

    // Active objective progress (informational).
    const objective = backend.activeObjective();
    if (objective && objective.status === 'in_progress') {
      try {
        const detail = await backend.objectiveDetail(objective.id);
        const total = (detail.tasks ?? []).length;
        const done = (detail.tasks ?? []).filter((task) => task.status === 'completed').length;
        if (total > 0) {
          cards.push({
            id: `objective:${objective.id}`, kind: 'objective', actionRequired: false, severity: 1,
            seq: lastSeqOf((e) => e.type === 'task.status') || 1,
            title: t('card.objective.title'), body: objective.title,
            whyDetail: t('card.objective.progress', { done: fmtNumber(done), total: fmtNumber(total) }),
            why: t('card.objective.why'), actions: [],
          });
        }
      } catch { /* skip */ }
    }

    // Fresh artifact (informational).
    const artifactSeq = lastSeqOf((e) => e.type === 'artifact.created');
    if (artifactSeq > 0) {
      const ev = backend.ring.find((e) => e.seq === artifactSeq);
      if (ev && Date.now() - ev.at < 120000) {
        cards.push({
          id: `artifact:${ev.payload?.artifactId}`, kind: 'artifact', actionRequired: false, severity: 1,
          seq: artifactSeq,
          title: t('card.artifact.title'), body: ev.payload?.name ?? '', why: t('card.artifact.why'),
          actions: [{ label: t('action.open'), cls: '', href: `/api/artifacts/${ev.payload?.artifactId}/content` }],
        });
      }
    }

    // System degradation (mock model / worker offline).
    const h = backend.health;
    if (h?.adapter?.name === 'mock') {
      cards.push({
        id: 'health:mock', kind: 'health', actionRequired: false, severity: 2, seq: 1,
        title: t('card.health.title'), body: t('card.health.whyMock'), why: h.adapter.reason ?? '', actions: [],
      });
    } else if (!backend.workerFresh()) {
      cards.push({
        id: 'health:worker', kind: 'health', actionRequired: false, severity: 2, seq: 1,
        title: t('card.health.title'), body: t('card.health.whyWorker'), why: '', actions: [],
      });
    }

    // Language-switch offer (never auto-switch).
    const offer = langOffer.current();
    if (offer) {
      cards.push({
        id: `language:${offer.to}`, kind: 'language', actionRequired: false, severity: 0, seq: offer.seq,
        title: offer.to === 'ar' ? 'تبديل الواجهة إلى العربية؟' : 'Switch interface to English?',
        body: '', why: t('card.language.why', { n: fmtNumber(offer.count) }),
        actions: [
          { label: t('action.switch'), cls: 'primary', run: () => locale.set(offer.to) },
          { label: t('action.keep'), cls: '', run: () => langOffer.decline() },
        ],
      });
    }

    return cards;
  }

  function renderCard(card) {
    return el('div', { class: `card k-${card.kind}`, role: 'group' },
      el('div', { class: 'row' },
        el('b', { class: 'grow' }, prose(card.title)),
        el('button', {
          class: 'sbtn small', 'aria-label': t('action.dismiss'),
          onclick: () => {
            dismissed.add(dismissKey(card));
            saveDismissed(dismissed);
            void render();
          },
        }, '✕'),
      ),
      card.body ? el('small', null, prose(card.body)) : null,
      card.whyDetail ? el('small', null, prose(card.whyDetail)) : null,
      el('div', { class: 'why' }, card.why),
      card.actions?.length
        ? el('div', { class: 'actions' }, card.actions.map((action) => el('button', {
            class: `sbtn small ${action.cls ?? ''}`,
            onclick: async (e) => {
              if (action.run) return action.run();
              if (action.inspect) return onInspect?.(action.inspect);
              if (action.href) return window.open(action.href, '_blank', 'noopener');
              if (action.post) {
                e.currentTarget.disabled = true;
                await onAction(action.post[0], action.post[1]);
              }
            },
          }, action.label)))
        : null,
    );
  }

  async function render() {
    latest = rankCards(await collect(), dismissed);
    mount(rail, latest.map(renderCard));
  }

  registerRegion(() => void render());
  return { render };
}
