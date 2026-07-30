// ConversationStore.addAssistant: the Background Objective Completion
// Bridge delivers an already-complete assistant message (no streaming
// needed — it was generated entirely server-side), and the same message
// replayed via a later resync()/event redelivery must never duplicate.
import { test } from 'node:test';
import assert from 'node:assert';
import { ConversationStore } from '../../web/js/core/conversation.js';

test('addAssistant appends a complete (non-streaming) message', () => {
  const store = new ConversationStore();
  store.addAssistant('SIRA picked option B — here is why.', { id: 'msg_1' });
  assert.equal(store.messages.length, 1);
  assert.equal(store.messages[0].role, 'assistant');
  assert.equal(store.messages[0].content, 'SIRA picked option B — here is why.');
  assert.equal(store.messages[0].streaming, undefined, 'not marked streaming — the text already arrived complete');
});

test('addAssistant with the same id is a no-op the second time (event replay / resync race)', () => {
  const store = new ConversationStore();
  store.addAssistant('first delivery', { id: 'msg_dup' });
  store.addAssistant('duplicate delivery', { id: 'msg_dup' });
  assert.equal(store.messages.length, 1);
  assert.equal(store.messages[0].content, 'first delivery');
});

test('addAssistant without an id always appends (no false-positive de-dup)', () => {
  const store = new ConversationStore();
  store.addAssistant('a');
  store.addAssistant('b');
  assert.equal(store.messages.length, 2);
});

test('notifies subscribers on every real append', () => {
  const store = new ConversationStore();
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  store.addAssistant('x', { id: 'm1' });
  store.addAssistant('y', { id: 'm1' }); // de-duped — must NOT notify again
  assert.equal(notifications, 1);
});
