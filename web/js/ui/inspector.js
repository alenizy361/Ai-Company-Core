// Inspection panel: real execution details for a node (agent), a task, an
// execution, or an edge (the stored relation/event). All content fetched
// live from the read API; ids/paths render LTR-isolated.
import { el, mount, tech, prose } from '../core/dom.js';
import { t, fmtTime, fmtNumber } from '../i18n/i18n.js';
import { openLayer, closeLayer } from '../a11y/focus.js';

export function buildInspector({ backend, onError }) {
  const panel = document.getElementById('inspector');
  const ov = document.getElementById('inspectorOv');

  function close() {
    panel.classList.remove('open');
    ov.classList.remove('open');
    closeLayer(panel);
  }
  ov.addEventListener('click', close);

  function open(...children) {
    mount(panel,
      el('button', { class: 'sbtn small closeBtn', 'aria-label': t('controls.close'), onclick: close }, '✕'),
      ...children,
    );
    panel.classList.add('open');
    ov.classList.add('open');
    openLayer(panel, close);
  }

  function dl(pairs) {
    return el('dl', null, pairs.flatMap(([label, value]) =>
      value === null || value === undefined || value === '' ? [] : [el('dt', null, label), el('dd', null, value)]));
  }

  function chipEl(status) {
    return el('span', { class: `chip ${status}` }, status);
  }

  async function showAgent(key) {
    try {
      const data = await (await fetch(`/api/agents/${key}`)).json();
      const agent = data.agent;
      const name = document.documentElement.lang === 'ar' ? agent.name_ar : agent.name_en;
      const tierBtn = (tier) => el('button', {
        class: `sbtn small ${agent.model_tier === tier ? 'primary' : ''}`,
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          const res = await fetch(`/api/agents/${key}/model`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tier }),
          });
          if (!res.ok) onError?.(String(res.status));
          void showAgent(key);
        },
      }, tier);
      const sections = [
        el('h3', null, `${t('inspector.agent')}: `, prose(name)),
        dl([
          [t('inspector.status'), chipEl(backend.snapshot?.agents?.find((a) => a.key === key)?.status ?? agent.lifecycle)],
          [t('inspector.promptVersion'), agent.active_prompt_version_id ? tech(agent.active_prompt_version_id) : null],
        ]),
        el('section', null,
          el('h3', null, t('inspector.modelTier')),
          el('div', { class: 'actions' }, ['fast', 'balanced', 'reasoning'].map(tierBtn)),
          agent.model_tier === 'custom' && agent.model_custom ? tech(agent.model_custom) : null,
        ),
      ];
      const currentTaskId = backend.snapshot?.agents?.find((a) => a.key === key)?.taskId;
      if (currentTaskId) {
        sections.push(el('section', null,
          el('h3', null, t('inspector.currentTask')),
          el('button', { class: 'sbtn small', onclick: () => void showTask(currentTaskId) }, tech(currentTaskId)),
        ));
      } else {
        sections.push(el('section', null, el('div', { class: 'empty' }, t('inspector.noTask'))));
      }
      if (data.recentTasks?.length) {
        sections.push(el('section', null,
          el('h3', null, t('inspector.task')),
          data.recentTasks.slice(0, 6).map((task) => el('div', { class: 'card' },
            el('div', { class: 'row' },
              el('b', { class: 'grow' }, prose(task.title)), chipEl(task.status),
              el('button', { class: 'sbtn small', onclick: () => void showTask(task.id) }, t('action.details'))),
          )),
        ));
      }
      open(...sections);
    } catch (err) {
      onError?.(String(err?.message ?? err));
    }
  }

  async function showTask(id) {
    try {
      const data = await (await fetch(`/api/tasks/${id}`)).json();
      const task = data.task;
      const sections = [
        el('h3', null, `${t('inspector.task')}: `, prose(task.title)),
        dl([
          [t('inspector.status'), chipEl(task.status)],
          [t('inspector.agent'), task.agent_key],
          ['ID', tech(task.id)],
          [t('inspector.blocker'), task.blocker ? prose(task.blocker) : null],
        ]),
      ];
      if (task.status === 'failed' || task.status === 'blocked') {
        sections.push(el('div', { class: 'actions' },
          el('button', {
            class: 'sbtn small',
            onclick: async (e) => {
              e.currentTarget.disabled = true;
              await fetch(`/api/tasks/${id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
              void showTask(id);
            },
          }, `↻ ${t('action.retry')}`),
        ));
      }
      if (data.dependsOn?.length) {
        sections.push(el('section', null, el('h3', null, t('inspector.dependencies')),
          data.dependsOn.map((d) => el('div', { class: 'row' }, chipEl(d.status), prose(d.title)))));
      }
      if (data.dependents?.length) {
        sections.push(el('section', null, el('h3', null, t('inspector.dependents')),
          data.dependents.map((d) => el('div', { class: 'row' }, chipEl(d.status), prose(d.title)))));
      }
      if (data.artifacts?.length) {
        sections.push(el('section', null, el('h3', null, t('inspector.artifacts')),
          data.artifacts.map((a) => el('div', { class: 'row' },
            el('a', { href: `/api/artifacts/${a.id}/content`, target: '_blank', rel: 'noopener' }, prose(a.name)),
            tech(`${a.kind} · ${a.size_bytes}B`)))));
      }
      if (data.handoffs?.length) {
        sections.push(el('section', null, el('h3', null, t('inspector.handoffs')),
          data.handoffs.map((h) => el('div', { class: 'card' },
            el('small', null, `${h.from_agent} → ${h.to_agent}`),
            el('small', null, prose(h.summary ?? '')),
            Array.isArray(h.unresolved_issues) && h.unresolved_issues.length
              ? el('small', null, `${t('inspector.unresolved')}: `, prose(h.unresolved_issues.join('; ')))
              : null,
          ))));
      }
      if (data.executions?.length) {
        sections.push(el('section', null, el('h3', null, t('inspector.execution')),
          data.executions.map((ex) => el('div', { class: 'card' },
            el('div', { class: 'row' }, chipEl(ex.status), tech(ex.id),
              el('button', { class: 'sbtn small', onclick: () => void showExecution(ex.id) }, t('action.details'))),
            el('small', null, `${t('inspector.tokens')}: `, tech(`${ex.input_tokens}/${ex.output_tokens}`),
              ` · ${t('activity.turns', { n: fmtNumber(ex.turns_used) })}`),
          ))));
      }
      open(...sections);
    } catch (err) {
      onError?.(String(err?.message ?? err));
    }
  }

  async function showExecution(id) {
    try {
      const data = await (await fetch(`/api/executions/${id}`)).json();
      const ex = data.execution;
      const sections = [
        el('h3', null, `${t('inspector.execution')} `, tech(ex.id)),
        dl([
          [t('inspector.status'), chipEl(ex.status)],
          [t('inspector.agent'), ex.agent_key],
          [t('inspector.at'), fmtTime(ex.started_at)],
          [t('inspector.tokens'), tech(`${ex.input_tokens} in / ${ex.output_tokens} out`)],
        ]),
      ];
      if (data.toolCalls?.length) {
        sections.push(el('section', null, el('h3', null, t('inspector.toolCalls')),
          data.toolCalls.map((tc) => el('div', { class: 'card' },
            el('div', { class: 'row' }, tech(tc.tool), chipEl(tc.status)),
            tc.denial_reason ? el('small', null, prose(tc.denial_reason)) : null,
          ))));
      }
      if (data.events?.length) {
        sections.push(el('section', null, el('h3', null, t('inspector.events')),
          el('div', { id: 'eventFeed' }, data.events.slice(-30).map((ev) =>
            el('div', null, `${new Date(ev.created_at).toLocaleTimeString('en-GB')} ${ev.type}`)))));
      }
      open(...sections);
    } catch (err) {
      onError?.(String(err?.message ?? err));
    }
  }

  function showEdge(meta) {
    const rows = [
      [t('inspector.type'), t(`network.edge.${meta.type}`)],
      [t('inspector.from'), meta.fromAgent ?? t('network.core')],
      [t('inspector.to'), meta.toAgent ?? meta.agentKey ?? null],
      [t('inspector.task'), meta.taskId ? tech(meta.taskId) : null],
    ];
    open(
      el('h3', null, meta.label ?? t('inspector.event')),
      dl(rows),
      meta.taskId
        ? el('div', { class: 'actions' },
            el('button', { class: 'sbtn small', onclick: () => void showTask(meta.taskId) }, t('action.details')))
        : null,
    );
  }

  return {
    close,
    select(target) {
      if (target.kind === 'agent') void showAgent(target.key);
      else if (target.kind === 'task') void showTask(target.id);
      else if (target.kind === 'execution') void showExecution(target.id);
      else if (target.kind === 'edge') showEdge(target);
    },
  };
}
