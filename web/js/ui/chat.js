// Optional chat drawer — the SAME conversation as voice (one store), with
// typed input, streamed replies, and system notes. Renders exclusively from
// the ConversationStore; no separate history.
import { el, mount, prose } from '../core/dom.js';
import { t } from '../i18n/i18n.js';
import { registerRegion } from './shell.js';

export function buildChat({ conversation, onSend }) {
  const drawer = document.getElementById('chatDrawer');
  let inputValue = '';

  const render = () => {
    const prev = drawer.querySelector('#chatInp');
    if (prev) inputValue = prev.value;
    mount(drawer,
      el('div', { class: 'grab' }),
      el('h2', null, t('chat.title')),
      el('div', { id: 'chatMsgs', role: 'log', 'aria-label': t('chat.title') }),
      el('div', { id: 'chatRow' },
        el('input', {
          id: 'chatInp', placeholder: t('chat.placeholder'), autocomplete: 'off',
          'aria-label': t('chat.placeholder'), dir: 'auto', value: inputValue,
        }),
        el('button', { class: 'sbtn primary', id: 'chatSend', 'aria-label': t('chat.send') }, '➤'),
      ),
    );
    const send = () => {
      const inp = drawer.querySelector('#chatInp');
      const text = inp.value.trim();
      if (!text) return;
      inp.value = '';
      onSend(text);
    };
    drawer.querySelector('#chatSend').addEventListener('click', send);
    drawer.querySelector('#chatInp').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
    });
    renderMessages();
  };

  const renderMessages = () => {
    const log = drawer.querySelector('#chatMsgs');
    if (!log) return;
    mount(log, conversation.messages.map((m) => {
      if (m.role === 'system_note') {
        return el('div', { class: 'msg note' }, prose(m.content), m.tech ? el('div', { class: 'subnote' }, m.tech) : null);
      }
      return el('div', { class: `msg ${m.role === 'user' ? 'me' : 'ai'}` },
        prose(m.content),
        m.streaming ? el('span', { 'aria-hidden': 'true' }, ' ▌') : null,
      );
    }));
    log.scrollTop = log.scrollHeight;
  };

  registerRegion(render);
  conversation.subscribe(renderMessages);

  return {
    setUnsentText(text) {
      const inp = drawer.querySelector('#chatInp');
      if (inp && !inp.value) inp.value = text;
    },
  };
}
