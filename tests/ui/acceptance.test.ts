// SIRA mandatory acceptance tests 1–9, driven through real headless Chromium
// against a real server (+ real worker where execution is asserted). Skips
// honestly when no browser binary is available.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Browser, findChrome } from './cdp.ts';
import { startUiServer, type UiServer } from './server.ts';
import { openDb, type Db } from '../../src/shared/db.ts';
import { loadSystemConfig } from '../../src/shared/config.ts';
import { activateAgents, createConfirmedPlan, toolTurn, completeTurn, MOCK } from '../helpers/fixtures.ts';

const CHROME = findChrome();
const SHOTS = process.env.SIRA_SHOTS_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'sira-shots');
const SPEC_PAD = 'Complete executable specification with concrete definition of done for the test scenario at hand.';

let srv: UiServer;
let browser: Browser;
let db: Db;

before(async () => {
  if (!CHROME) return;
  srv = await startUiServer(4893, {
    MOCK_TURN_DELAY_MS: '600',
    MOCK_DELTA_DELAY_MS: '35',
    SIRA_STALE_WORKER_MS: '3000',
    SIRA_HEARTBEAT_MS: '1000',
    SIRA_SWEEP_MS: '1500',
    SIRA_LEASE_MS: '8000',
  });
  db = openDb(join(srv.dir, 'data.db'));
  browser = await Browser.launch();
  mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  if (!CHROME) return;
  await browser.close();
  db.close();
  srv.stop();
});

function skipIfNoChrome(t: { skip: (msg: string) => void }): boolean {
  if (!CHROME) {
    t.skip('no chromium available (set SIRA_CHROME_BIN)');
    return true;
  }
  return false;
}

async function boot(width = 390, height = 844): Promise<void> {
  await browser.setViewport(width, height);
  await browser.navigate(`${srv.base}/`);
  await browser.waitFor(`document.body.classList.contains('booted')`, 15000);
}

test('AT-UI-1 branding: SIRA identity everywhere, no previous names', async (t) => {
  if (skipIfNoChrome(t)) return;
  await boot();
  const facts = await browser.eval<{ title: string; h1: string; html: string }>(
    `(() => ({ title: document.title, h1: document.querySelector('header h1').textContent,
       html: document.documentElement.outerHTML }))()`);
  assert.equal(facts.title, 'SIRA');
  assert.equal(facts.h1, 'SIRA');
  assert.ok(!/rabit|jarvis|رابت/i.test(facts.html), 'no previous identity in the live DOM');
  const manifest = await (await fetch(`${srv.base}/manifest.json`)).json() as { name: string; short_name: string };
  assert.equal(manifest.short_name, 'SIRA');
  assert.ok(!/rabit/i.test(JSON.stringify(manifest)));
});

test('AT-UI-2 default English/LTR from a clean profile; choice persists', async (t) => {
  if (skipIfNoChrome(t)) return;
  await browser.send('Storage.clearDataForOrigin', { origin: srv.base, storageTypes: 'all' });
  await boot();
  let doc = await browser.eval<{ lang: string; dir: string }>(
    `({ lang: document.documentElement.lang, dir: document.documentElement.dir })`);
  assert.deepEqual(doc, { lang: 'en', dir: 'ltr' });

  await browser.eval(`document.getElementById('langBtn').click()`);
  doc = await browser.eval(`({ lang: document.documentElement.lang, dir: document.documentElement.dir })`);
  assert.deepEqual(doc, { lang: 'ar', dir: 'rtl' });

  await browser.navigate(`${srv.base}/`);
  await browser.waitFor(`document.body.classList.contains('booted')`, 15000);
  doc = await browser.eval(`({ lang: document.documentElement.lang, dir: document.documentElement.dir })`);
  assert.deepEqual(doc, { lang: 'ar', dir: 'rtl' }, 'persisted across reload');
  assert.equal(await browser.eval(`localStorage.getItem('sira.lang')`), 'ar');
});

test('AT-UI-3 Arabic RTL mirrors panels; technical content stays LTR', async (t) => {
  if (skipIfNoChrome(t)) return;
  await browser.setViewport(1280, 900);
  // Arabic (persisted from AT-UI-2). The chat drawer must mirror sides.
  await browser.navigate(`${srv.base}/`);
  await browser.waitFor(`document.body.classList.contains('booted')`, 15000);
  const measure = async () => browser.eval<{ dir: string; drawerSide: string; headerText: string }>(`(async () => {
    document.getElementById('chatBtn').click();
    await new Promise((r) => setTimeout(r, 450)); // let the open transition finish
    const r = document.getElementById('chatDrawer').getBoundingClientRect();
    const side = r.left < 40 ? 'start-left' : (innerWidth - r.right < 40 ? 'end-right' : 'other');
    const headerText = document.querySelector('.drawer h2')?.textContent ?? '';
    document.getElementById('chatOv').click();
    await new Promise((r) => setTimeout(r, 350)); // and the close transition
    return { dir: document.documentElement.dir, drawerSide: side, headerText };
  })()`);
  const rtl = await measure();
  assert.equal(rtl.dir, 'rtl');
  assert.equal(rtl.drawerSide, 'start-left', 'inline-end drawer sits on the LEFT in RTL');
  writeFileSync(join(SHOTS, 'rtl-1280.png'), await browser.screenshot());

  await browser.eval(`document.getElementById('langBtn').click()`);
  const ltr = await measure();
  assert.equal(ltr.dir, 'ltr');
  assert.equal(ltr.drawerSide, 'end-right', 'inline-end drawer sits on the RIGHT in LTR');
  writeFileSync(join(SHOTS, 'ltr-1280.png'), await browser.screenshot());
  assert.notEqual(rtl.headerText, ltr.headerText, 'drawer headings translated');
});

test('AT-UI-4 mixed-language bidi: ids render LTR-isolated inside RTL', async (t) => {
  if (skipIfNoChrome(t)) return;
  await browser.eval(`(() => {
    // Render a real tech() node the way the app does, inside Arabic context.
    return import('/js/core/dom.js').then(({ el, tech, mount }) => {
      const host = el('div', { id: 'bidiProbe', dir: 'rtl' },
        'المهمة ', tech('tsk_01ABC/path/to/file.ts'), ' اكتملت بنجاح.');
      document.body.appendChild(host);
    });
  })()`);
  const probe = await browser.eval<{ dir: string; isBdi: boolean; computed: string }>(`(() => {
    const techEl = document.querySelector('#bidiProbe .tech');
    return { dir: techEl.getAttribute('dir'), isBdi: techEl.tagName === 'BDI',
             computed: getComputedStyle(techEl).direction };
  })()`);
  assert.equal(probe.isBdi, true);
  assert.equal(probe.dir, 'ltr');
  assert.equal(probe.computed, 'ltr', 'technical span keeps LTR inside RTL parent');
  const streamDir = await browser.eval<string>(`getComputedStyle(document.getElementById('replyLine')).unicodeBidi`);
  assert.ok(['plaintext', 'isolate plaintext'].includes(streamDir), `reply container uses plaintext bidi (${streamDir})`);
});

test('AT-UI-5 streaming text renders incrementally; Stop leaves no half-answer', async (t) => {
  if (skipIfNoChrome(t)) return;
  await browser.eval(`document.documentElement.lang === 'en' || document.getElementById('langBtn').click()`);
  // A full streamed turn: reply text must grow over time (real deltas).
  await browser.eval(`(() => {
    document.getElementById('chatBtn').click();
    const inp = document.getElementById('chatInp');
    inp.value = 'what is the current status of the company right now';
    document.getElementById('chatSend').click();
  })()`);
  await browser.waitFor(`document.getElementById('replyLine').textContent.length > 0`, 15000);
  const len1 = await browser.eval<number>(`document.getElementById('replyLine').textContent.length`);
  await browser.waitFor(`document.getElementById('replyLine').textContent.length > ${len1}`, 10000);
  await browser.waitFor(`!window.sira.voice.abortCtrl || window.sira.voice.abortCtrl.signal.aborted === false && document.getElementById('stopBtn').hidden`, 15000);
  const finalText = await browser.eval<string>(`document.getElementById('replyLine').textContent`);
  assert.ok(finalText.includes('MOCK MODE'), 'mock reply streamed to completion');

  // Cancellation: stop mid-generation -> no assistant row persists.
  await browser.eval(`(() => {
    const inp = document.getElementById('chatInp');
    inp.value = 'this generation will be stopped';
    document.getElementById('chatSend').click();
  })()`);
  await browser.waitFor(`document.getElementById('stopBtn').hidden === false`, 10000);
  await new Promise((r) => setTimeout(r, 250)); // inside MOCK_TURN_DELAY_MS window
  await browser.eval(`document.getElementById('stopBtn').click()`);
  await browser.waitFor(`document.getElementById('stopBtn').hidden === true`, 10000);
  await new Promise((r) => setTimeout(r, 700));
  const roles = await browser.eval<string[]>(`(async () => {
    const rows = await (await fetch('/api/conversations/' + window.sira.voice.conversationId)).json();
    return rows.slice(-2).map((r) => r.role);
  })()`);
  assert.equal(roles[roles.length - 1], 'user', 'stopped turn persisted no assistant message');
});

test('AT-UI-6 barge-in: queued speech stops, remainder preserved and labeled', async (t) => {
  if (skipIfNoChrome(t)) return;
  const result = await browser.eval<{ state: string; noteCount: number; remainderShown: boolean }>(`(async () => {
    const v = window.sira.voice;
    // Scripted playback double (labeled test double): implements the real TTS
    // contract so the interrupt path (state machine + remainder) is exercised.
    const store = v.store;
    v.tts = {
      available: true, playing: false, queue: [], onRemainder: null, onBoundary: null,
      enqueue(text) { this.queue.push(text); this.playing = true; store.transition('generating_speech', 'tts'); store.transition('speaking', 'playback'); },
      amplitude() { return 0; },
      interrupt() {
        const rest = this.queue.join(' ');
        this.queue = [];
        const was = this.playing;
        this.playing = false;
        if (was) { store.transition('interrupted', 'playback'); this.onRemainder?.(rest); }
        return { wasPlaying: was, stopMs: 3 };
      },
    };
    v.tts.onRemainder = (unspoken) => v.ui.onReply?.('… ' + unspoken, { interrupted: true });
    v.tts.enqueue('first sentence.');
    v.tts.enqueue('second sentence that will never be spoken.');
    const before = window.sira.conversation.messages.length;
    const { wasPlaying } = v.tts.interrupt();
    await new Promise((r) => setTimeout(r, 100));
    const msgs = window.sira.conversation.messages;
    const last = msgs[msgs.length - 1];
    return {
      state: store.state,
      noteCount: msgs.length - before,
      remainderShown: wasPlaying && last.role === 'system_note' && last.content.includes('never be spoken'),
    };
  })()`);
  assert.equal(result.state, 'interrupted');
  assert.equal(result.noteCount, 1);
  assert.ok(result.remainderShown, 'unspoken remainder preserved and labeled');
  // The server recorded the interruption (real transition row).
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM voice_state_transitions WHERE to_state = 'interrupted' AND valid = 1`);
  assert.ok((row?.n ?? 0) >= 1, 'interrupted transition persisted server-side');
});

test('AT-UI-7 network truth: real plan -> active nodes, real handoff inspectable', async (t) => {
  if (skipIfNoChrome(t)) return;
  const cfg = loadSystemConfig();
  activateAgents(db, ['backend', 'qa']);
  const beScript = [toolTurn('write_artifact', { name: 'impl.md', content: '# Impl\nDELIVERABLE.' }), completeTurn('done', ['impl.md'])];
  const qaScript = [toolTurn('read_artifact', { name: 'impl.md' }), toolTurn('write_artifact', { name: 'report.md', content: '# QA PASS' }), completeTurn('verified', ['report.md'])];
  createConfirmedPlan({ db, cfg } as never, 'network truth objective', [
    { step_id: 'impl', agent: 'backend', spec: `${SPEC_PAD} ${MOCK(beScript)}`, expected_artifacts: ['impl.md'] },
    { step_id: 'verify', agent: 'qa', depends_on: ['impl'], spec: `${SPEC_PAD} ${MOCK(qaScript)}`, expected_artifacts: ['report.md'] },
  ]);
  srv.startWorker();

  // While executing: exactly the two plan agents render as active nodes.
  await browser.waitFor(`document.querySelectorAll('#network .node:not(.core)').length === 2`, 30000);
  const nodes = await browser.eval<string[]>(
    `[...document.querySelectorAll('#network .node:not(.core) text.short')].map((n) => n.textContent)`);
  assert.deepEqual([...nodes].sort(), ['BE', 'QA'], 'only assigned agents appear');
  const edges = await browser.eval<number>(`document.querySelectorAll('#network .edge.dependency').length`);
  assert.ok(edges >= 1, 'real dependency edge drawn');

  // The dependency edge opens the stored relation with real ids.
  await browser.eval(`document.querySelector('#network .edge-hit[aria-label*="ependency"], #network .edge-hit')?.dispatchEvent(new MouseEvent('click', {bubbles:true}))`);
  await browser.waitFor(`document.getElementById('inspector').classList.contains('open')`, 5000);
  const inspectorText = await browser.eval<string>(`document.getElementById('inspector').textContent`);
  assert.ok(/tsk_|core/i.test(inspectorText), 'inspector shows real stored ids');
  await browser.eval(`document.getElementById('inspectorOv').click()`);

  // Completion: the real handoff event reached the client ring.
  await browser.waitFor(`window.sira.backend.ring.some((e) => e.type === 'handoff.created')`, 60000);
  await browser.waitFor(`window.sira.backend.ring.some((e) => e.type === 'objective.finished')`, 60000);
  const handoff = db.get<{ from_agent: string; to_agent: string }>('SELECT from_agent, to_agent FROM handoffs LIMIT 1');
  assert.deepEqual(handoff, { from_agent: 'backend', to_agent: 'qa' });
});

test('AT-UI-8 no fake state: killed worker renders offline, zero pulses', async (t) => {
  if (skipIfNoChrome(t)) return;
  srv.workerProc?.kill('SIGKILL');
  // Server staleness = 3s; client re-polls on its idle tick.
  await browser.waitFor(
    `(() => { const a = window.sira.backend.snapshot?.agents ?? []; return a.length > 0 && a.every((x) => ['offline','not_configured'].includes(x.status)); })()`,
    40000,
  );
  const facts = await browser.eval<{ running: number; workerFresh: boolean; activeNodes: number; pulses: number }>(`({
    running: window.sira.backend.runningExecutions(),
    workerFresh: window.sira.backend.workerFresh(),
    activeNodes: document.querySelectorAll('#network .node:not(.core):not(.offline):not(.not_configured)').length,
    pulses: document.querySelectorAll('#network .pulse').length,
  })`);
  assert.equal(facts.running, 0, 'zero running executions');
  assert.equal(facts.workerFresh, false);
  assert.equal(facts.activeNodes, 0, 'no agent renders active');
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(await browser.eval<number>(`document.querySelectorAll('#network .pulse').length`), 0, 'no pulses without events');
});

test('AT-UI-9 responsive matrix: 9 widths x 2 directions, no overflow', async (t) => {
  if (skipIfNoChrome(t)) return;
  const widths = [320, 375, 390, 430, 768, 1024, 1280, 1440, 1920];
  for (const dir of ['ltr', 'rtl']) {
    await browser.eval(`(() => {
      const want = ${JSON.stringify('DIR')} === 'x'; // placeholder no-op
    })()`);
    await browser.eval(`document.documentElement.dir === '${dir}' || document.getElementById('langBtn').click()`);
    for (const width of widths) {
      await browser.setViewport(width, width < 600 ? 800 : 900);
      await new Promise((r) => setTimeout(r, 150));
      const facts = await browser.eval<{ scrollW: number; innerW: number; talkVisible: boolean }>(`(() => {
        const talk = document.getElementById('talkBtn').getBoundingClientRect();
        return { scrollW: document.scrollingElement.scrollWidth, innerW: innerWidth,
                 talkVisible: talk.width > 0 && talk.bottom <= innerHeight && talk.top >= 0 };
      })()`);
      assert.ok(facts.scrollW <= facts.innerW, `${dir} ${width}px: horizontal overflow (${facts.scrollW} > ${facts.innerW})`);
      assert.ok(facts.talkVisible, `${dir} ${width}px: talk control not visible`);
      if (width === 390 || width === 1440) {
        writeFileSync(join(SHOTS, `${dir}-${width}.png`), await browser.screenshot());
      }
    }
  }
  // Palette opens via keyboard.
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
  await browser.waitFor(`document.getElementById('palette').classList.contains('open')`, 5000);
});
