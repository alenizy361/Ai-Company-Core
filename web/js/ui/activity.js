// Activity view — every card is a real backend entity; all rendering goes
// through safe DOM builders (no innerHTML anywhere). Action buttons disable
// while their POST is in flight so double-taps cannot double-fire.
import { el, mount, tech, prose } from '../core/dom.js';
import { t, fmtTime, fmtNumber } from '../i18n/i18n.js';
import { registerRegion } from './shell.js';

function chip(status) {
  return el('span', { class: `chip ${status}` }, status);
}

function emptyNote(key = 'activity.none') {
  return el('div', { class: 'empty' }, t(key));
}

async function act(button, path, body, after) {
  button.disabled = true;
  try {
    const res = await fetch(path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) after?.error?.(data?.error?.message ?? String(res.status));
  } finally {
    button.disabled = false;
    after?.done?.();
  }
}

export function buildActivity({ backend, onError, onInspect }) {
  const drawer = document.getElementById('actDrawer');

  const skeleton = () => {
    mount(drawer,
      el('div', { class: 'grab' }),
      el('h2', null, t('activity.plans')), el('div', { id: 'secPlans' }),
      el('h2', null, t('activity.running')), el('div', { id: 'secRunning' }),
      el('h2', null, t('activity.approvals')), el('div', { id: 'secApprovals' }),
      el('h2', null, t('activity.waiting')), el('div', { id: 'secWaiting' }),
      el('h2', null, t('activity.done')), el('div', { id: 'secDone' }),
      el('h2', null, t('activity.failed')), el('div', { id: 'secFailed' }),
      el('h2', null, t('activity.agents')), el('div', { id: 'agentsGrid' }),
      el('h2', null, t('activity.health')), el('div', { id: 'secHealth' }),
      el('h2', null, t('activity.events')), el('div', { id: 'eventFeed' }),
    );
    void render();
  };
  registerRegion(skeleton);

  const after = { error: onError, done: () => void render() };

  async function render() {
    const s = backend.snapshot;
    if (!s || !drawer.querySelector('#secPlans')) return;
    const fresh = backend.workerFresh();

    // Plans awaiting confirmation.
    const planCards = [];
    for (const objective of s.objectives.filter((o) => o.status === 'plan_proposed').slice(0, 5)) {
      try {
        const detail = await backend.objectiveDetail(objective.id);
        for (const plan of (detail.plans ?? []).filter((p) => p.status === 'proposed')) {
          const steps = Array.isArray(plan.raw_json?.plan) ? plan.raw_json.plan : [];
          planCards.push(el('div', { class: 'card k-plan' },
            el('div', { class: 'row' }, el('b', { class: 'grow' }, prose(objective.title)), chip('queued')),
            el('small', null, prose(plan.reply ?? '')),
            el('small', null, steps.length
              ? steps.map((st, i) => [i > 0 ? ' ← ' : '', `${st.agent}: `, prose(st.title)]).flat()
              : t('activity.answerOnly')),
            el('div', { class: 'actions' },
              el('button', {
                class: 'sbtn ok small',
                onclick: (e) => act(e.currentTarget, `/api/plans/${plan.id}/confirm`, {}, after),
              }, `✓ ${t('action.confirm')}`),
              el('button', {
                class: 'sbtn danger small',
                onclick: (e) => act(e.currentTarget, `/api/plans/${plan.id}/reject`, { reason: 'rejected from board' }, after),
              }, `✗ ${t('action.reject')}`),
            ),
          ));
        }
      } catch { /* detail fetch failed; next refresh retries */ }
    }
    mount(drawer.querySelector('#secPlans'), planCards.length ? planCards : emptyNote());

    // Running now (honest: empty when the worker is stale).
    const running = fresh ? s.runningExecutions : [];
    mount(drawer.querySelector('#secRunning'),
      running.length
        ? running.map((e) => el('div', { class: 'card' },
            el('div', { class: 'row' },
              el('b', { class: 'grow' }, e.agent_key), chip(e.status),
              el('button', { class: 'sbtn small', onclick: () => onInspect?.({ kind: 'execution', id: e.id }) }, t('action.details'))),
            el('small', null, tech(e.id), ` · ${t('activity.started', { time: fmtTime(e.started_at) })} · ${t('activity.turns', { n: fmtNumber(e.turns_used) })}`),
          ))
        : emptyNote(fresh ? 'activity.nothingExecuting' : 'activity.workerOfflineNothing'));

    // Approvals.
    try {
      const approvals = await (await fetch('/api/approvals?status=pending')).json();
      mount(drawer.querySelector('#secApprovals'),
        approvals.length
          ? approvals.map((a) => el('div', { class: 'card k-approval' },
              el('div', { class: 'row' }, el('b', { class: 'grow' }, prose(a.summary))),
              el('div', { class: 'actions' },
                el('button', {
                  class: 'sbtn ok small',
                  onclick: (e) => act(e.currentTarget, `/api/approvals/${a.id}/decide`, { decision: 'approved', via: 'ui' }, after),
                }, `✓ ${t('action.approve')}`),
                el('button', {
                  class: 'sbtn danger small',
                  onclick: (e) => act(e.currentTarget, `/api/approvals/${a.id}/decide`, { decision: 'rejected', via: 'ui' }, after),
                }, `✗ ${t('action.reject')}`),
              ),
            ))
          : emptyNote());
    } catch { /* keep previous */ }

    // Waiting counts.
    const counts = s.taskCounts ?? {};
    const waiting = ['queued', 'waiting_for_dependency', 'blocked', 'waiting_for_approval']
      .filter((k) => counts[k])
      .map((k) => el('div', { class: 'card' }, el('div', { class: 'row' }, chip(k), el('b', null, fmtNumber(counts[k])))));
    mount(drawer.querySelector('#secWaiting'), waiting.length ? waiting : emptyNote());

    // Recently completed.
    const done = s.objectives.filter((o) => ['completed', 'failed'].includes(o.status)).slice(0, 6)
      .map((o) => el('div', { class: 'card' }, el('div', { class: 'row' }, el('b', { class: 'grow' }, prose(o.title)), chip(o.status))));
    mount(drawer.querySelector('#secDone'), done.length ? done : emptyNote());

    // Failures with retry.
    try {
      const failures = await (await fetch('/api/failures')).json();
      const cards = failures.failedTasks.slice(0, 8).map((task) => el('div', { class: 'card k-failure' },
        el('div', { class: 'row' }, el('b', { class: 'grow' }, prose(task.title)), chip(task.status)),
        el('small', null, task.agent_key, ' · ', t('activity.attempt', { n: task.attempt_count, max: task.max_attempts }), task.blocker ? [' · ', prose(task.blocker)] : null),
        el('div', { class: 'actions' },
          el('button', {
            class: 'sbtn small',
            onclick: (e) => act(e.currentTarget, `/api/tasks/${task.id}/retry`, {}, after),
          }, `↻ ${t('action.retry')}`),
          el('button', { class: 'sbtn small', onclick: () => onInspect?.({ kind: 'task', id: task.id }) }, t('action.details')),
        ),
      ));
      mount(drawer.querySelector('#secFailed'), cards.length ? cards : emptyNote());
    } catch { /* keep previous */ }

    // Agents.
    mount(drawer.querySelector('#agentsGrid'), s.agents.map((a) =>
      el('div', { class: 'card', role: 'button', tabindex: '0', onclick: () => onInspect?.({ kind: 'agent', key: a.key }) },
        el('div', { class: 'row' }, el('b', { class: 'grow' }, a.short), chip(a.status)),
        el('small', null, document.documentElement.lang === 'ar' ? a.nameAr : a.nameEn),
      )));

    // Health.
    const h = backend.health;
    mount(drawer.querySelector('#secHealth'), h
      ? el('div', { class: 'card k-health' }, el('small', null,
          t('activity.healthLine', {
            db: h.db?.ok ? 'ok' : 'FAILED',
            worker: h.worker?.online ? `online (${h.worker.count})` : 'OFFLINE',
            model: `${h.adapter?.name} (${h.adapter?.reason ?? ''})`,
            voice: `stt=${h.voiceProviders?.stt} tts=${h.voiceProviders?.tts} wake=${h.voiceProviders?.wake}`,
            approvals: h.pendingApprovals ?? 0,
          })))
      : emptyNote('activity.healthUnavailable'));

    // Event feed (LTR technical island).
    mount(drawer.querySelector('#eventFeed'), backend.ring.slice(-40).reverse().map((e) =>
      el('div', null, `${new Date(e.at).toLocaleTimeString('en-GB')} ${e.type} ${e.agentKey ?? ''} ${e.payload?.to ?? e.payload?.tool ?? ''}`)));
  }

  return { render };
}
