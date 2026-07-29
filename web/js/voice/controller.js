// VoiceSessionManager: capture -> STT -> /api/converse (SSE) -> TTS, with
// streaming deltas, barge-in, stoppable generation, hold-to-talk and
// continuous mode. Providers are pluggable; browser-native is the working
// fallback until external provider keys exist server-side.
import { VoiceStateStore } from './session-store.js';
import { AudioCapture } from './capture.js';
import { WebSpeechSTT } from './stt.js';
import { SpeechSynthesisTTS } from './tts.js';
import { prefs } from '../core/prefs.js';
import { isArabic } from '../i18n/bidi.js';

async function* sseStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

export class VoiceController {
  constructor(ui) {
    // ui: {onTranscript, onDelta, onReply, onRoute, onError({key,params}), onStateChange, onGenerating(bool)}
    this.ui = ui;
    this.store = new VoiceStateStore();
    this.capture = new AudioCapture(this.store);
    this.stt = new WebSpeechSTT(this.store);
    this.tts = new SpeechSynthesisTTS(this.store);
    this.conversationId = prefs.get('conversationId') || null;
    this.lang = prefs.get('lang') || 'en';
    // Speech language is independent of the interface language: it follows
    // the language the owner actually uses (spoken or typed), persisted, so
    // an Arabic speaker on an English UI is still recognized.
    this.speechLang = prefs.get('speechLang') || this.lang;
    this.busy = false;
    this.holding = false;
    this.continuous = prefs.bool('continuous');
    this.abortCtrl = null;
    this.tts.onRemainder = (unspoken) => ui.onReply?.(`… ${unspoken}`, { interrupted: true });
    this.store.subscribe((state, from) => {
      ui.onStateChange?.(state, from);
      // Continuous mode: after real playback drains back to ready, re-listen.
      if (this.continuous && state === 'ready' && from === 'speaking' && !this.capture.muted) {
        setTimeout(() => {
          if (this.store.state === 'ready') void this.talk();
        }, 150);
      }
    });
  }

  async init() {
    try {
      await this.store.openSession();
      try {
        const health = await (await fetch('/api/health')).json();
        const active = health.voiceProviders ?? {};
        if (active.stt === 'deepgram' || active.tts === 'fish-audio') {
          const ext = await import('./providers-ext.js');
          if (active.stt === 'deepgram') this.stt = new ext.DeepgramTurnSTT(this.store, this.capture, this.store.turnConfig);
          if (active.tts === 'fish-audio') {
            this.tts = new ext.FishAudioTTS(this.store);
            this.tts.onRemainder = (unspoken) => this.ui.onReply?.(`… ${unspoken}`, { interrupted: true });
          }
        }
      } catch { /* provider matrix unavailable -> browser-native providers stay */ }
      this.store.transition('ready', 'client_boot');
    } catch {
      this.store.transition('offline', 'client_boot');
    }
  }

  amplitude() {
    return Math.max(this.capture.amplitude(), this.tts.amplitude());
  }

  get state() {
    return this.store.state;
  }

  setContinuous(on) {
    this.continuous = on;
    prefs.setBool('continuous', on);
    this.reportMode(on ? 'continuous' : 'push_to_talk');
  }

  reportMode(mode) {
    if (!this.store.session) return;
    fetch(`/api/voice-session/${this.store.session.id}/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, token: this.store.session.token }),
      keepalive: true,
    }).catch(() => {});
  }

  toggleMute() {
    this.capture.setMuted(!this.capture.muted);
    if (this.capture.muted) {
      this.stt.abort();
      this.tts.interrupt();
    }
    return this.capture.muted;
  }

  /** Stop an in-flight generation (the Stop control). */
  stopGeneration() {
    this.abortCtrl?.abort();
    this.tts.interrupt();
  }

  /** Hold-to-talk: pointer held = capture window. */
  holdStart() {
    this.holding = true;
    this.reportMode('hold');
    void this.talk();
  }

  holdEnd() {
    this.holding = false;
    this.stt.stop?.();
  }

  /** Tap-to-talk. If SIRA is speaking, this is the barge-in. */
  async talk() {
    if (this.capture.muted) return;
    const t0 = performance.now();

    if (this.tts.playing) {
      const { stopMs } = this.tts.interrupt();
      this.store.reportMetrics([{ metric: 'barge_in_stop', value_ms: stopMs }]);
    }
    if (this.busy) return;
    this.busy = true;

    try {
      const captureOk = await this.capture.start();
      this.store.reportMetrics([{ metric: 'mic_ui_reaction', value_ms: performance.now() - t0 }]);

      let text = null;
      if (captureOk && this.stt.available) {
        this.store.transition('listening', 'capture');
        const sttStart = performance.now();
        const result = await this.stt.start(this.speechLang, (interim) => this.ui.onTranscript?.(interim, false));
        if (result?.text) {
          text = result.text;
          this.store.reportMetrics([{ metric: 'stt_turn', value_ms: performance.now() - sttStart }]);
        }
      } else {
        this.ui.onError?.({ key: this.stt.available ? 'error.micUnavailable' : 'error.sttUnavailable' });
        if (this.store.state === 'listening') this.store.transition('ready', 'capture');
        return;
      }
      this.capture.stop();

      if (!text) {
        if (['listening', 'transcribing'].includes(this.store.state)) this.store.transition('ready', 'stt');
        return;
      }
      this.ui.onTranscript?.(text, true);
      await this.sendText(text, 'voice', t0);
    } finally {
      this.busy = false;
    }
  }

  /** Shared by voice turns and the typed chat drawer (same conversation). */
  async sendText(text, modality, t0 = performance.now()) {
    // Every message (typed or spoken) teaches the recognizer which language
    // to listen for next — so typing Arabic once fixes Arabic voice input
    // even while the interface stays English.
    const detected = isArabic(text) ? 'ar' : 'en';
    if (detected !== this.speechLang) {
      this.speechLang = detected;
      prefs.set('speechLang', detected);
    }
    this.abortCtrl = new AbortController();
    this.ui.onGenerating?.(true);
    let response;
    try {
      response = await fetch('/api/converse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: this.abortCtrl.signal,
        body: JSON.stringify({
          text,
          modality,
          lang: isArabic(text) ? 'ar' : 'en',
          conversationId: this.conversationId,
          voiceSessionId: this.store.session?.id,
          voiceToken: this.store.session?.token,
        }),
      });
      if (!response.ok || !response.body) throw new Error(`converse ${response.status}`);
    } catch (err) {
      this.ui.onGenerating?.(false);
      if (this.abortCtrl.signal.aborted) {
        if (['thinking', 'creating_plan'].includes(this.store.state)) this.store.mirror('ready');
        return { aborted: true };
      }
      this.store.transition('offline', 'transport');
      this.ui.onError?.({ key: 'error.backendUnreachable', params: { detail: err.message }, preserveText: text });
      return {};
    }

    let firstSayAt = null;
    let deltaText = '';
    let fullSay = '';
    let aborted = false;
    try {
      for await (const { event, data } of sseStream(response)) {
        if (event === 'delta') {
          deltaText += data.text;
          this.ui.onDelta?.(deltaText);
        } else if (event === 'say') {
          if (firstSayAt === null) {
            firstSayAt = performance.now();
            this.store.reportMetrics([{ metric: 'first_say', value_ms: firstSayAt - t0 }]);
          }
          fullSay += (fullSay ? ' ' : '') + data.text;
          if (!deltaText) this.ui.onDelta?.(fullSay); // non-streaming adapters
          if (modality === 'voice' && this.tts.available && !this.capture.muted) this.tts.enqueue(data.text);
        } else if (event === 'state') {
          this.store.mirror(data.state);
        } else if (event === 'route') {
          this.ui.onRoute?.(data);
        } else if (event === 'meta') {
          this.conversationId = data.conversationId;
          prefs.set('conversationId', this.conversationId);
        } else if (event === 'done') {
          this.ui.onReply?.(data.say ?? deltaText ?? fullSay, { done: true });
        } else if (event === 'error') {
          this.ui.onError?.({ key: 'error.modelUnavailable', params: { reference: data.reference ?? '' } });
        }
      }
    } catch (err) {
      if (this.abortCtrl.signal.aborted) {
        aborted = true;
      } else {
        this.store.transition('reconnecting', 'transport');
        this.ui.onError?.({ key: 'error.streamInterrupted', params: { detail: err.message } });
      }
    } finally {
      this.ui.onGenerating?.(false);
    }
    if (['thinking', 'creating_plan'].includes(this.store.state)) this.store.mirror('ready');
    if (modality === 'voice' && fullSay && !aborted) {
      this.store.reportMetrics([{ metric: 'e2e_turn', value_ms: performance.now() - t0 }]);
    }
    return { aborted, say: fullSay || deltaText };
  }
}
