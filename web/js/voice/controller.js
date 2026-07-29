// VoiceSessionManager: wires capture -> STT -> /api/converse (SSE) -> TTS,
// with barge-in and turn-level latency metrics. Providers are pluggable; the
// browser-native set is the working fallback until external provider keys are
// configured server-side (see /api/health voiceProviders).
import { VoiceStateStore } from './session-store.js';
import { AudioCapture } from './capture.js';
import { WebSpeechSTT } from './stt.js';
import { SpeechSynthesisTTS } from './tts.js';

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
    this.ui = ui; // {onTranscript, onReply, onRoute, onError, onStateChange}
    this.store = new VoiceStateStore();
    this.capture = new AudioCapture(this.store);
    this.stt = new WebSpeechSTT(this.store);
    this.tts = new SpeechSynthesisTTS(this.store);
    this.conversationId = localStorage.getItem('rabit.conversationId') || null;
    this.lang = localStorage.getItem('rabit.lang') || 'ar';
    this.busy = false;
    this.tts.onRemainder = (unspoken) => ui.onReply?.(`… ${unspoken}`, { interrupted: true });
    this.store.subscribe((state, from) => ui.onStateChange?.(state, from));
  }

  async init() {
    try {
      await this.store.openSession();
      this.store.transition('ready', 'client_boot');
    } catch {
      this.store.transition('offline', 'client_boot');
    }
  }

  /** Combined input level for the orb: real mic while listening, real playback while speaking. */
  amplitude() {
    return Math.max(this.capture.amplitude(), this.tts.amplitude());
  }

  get state() {
    return this.store.state;
  }

  toggleMute() {
    this.capture.setMuted(!this.capture.muted);
    if (this.capture.muted) {
      this.stt.abort();
      this.tts.interrupt();
    }
    return this.capture.muted;
  }

  /** Tap-to-talk. If RABIT is speaking, this is the barge-in. */
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
        const result = await this.stt.start(this.lang, (interim) => this.ui.onTranscript?.(interim, false));
        if (result?.text) {
          text = result.text;
          this.store.reportMetrics([{ metric: 'stt_turn', value_ms: performance.now() - sttStart }]);
        }
      } else {
        // Degradation: STT or mic unavailable -> typed input remains available.
        this.ui.onError?.(this.stt.available ? 'microphone unavailable — type instead' : 'speech recognition unavailable in this browser — type instead');
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
    let response;
    try {
      response = await fetch('/api/converse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          modality,
          lang: /[؀-ۿ]/.test(text) ? 'ar' : 'en',
          conversationId: this.conversationId,
          voiceSessionId: this.store.session?.id,
          voiceToken: this.store.session?.token,
        }),
      });
      if (!response.ok || !response.body) throw new Error(`converse ${response.status}`);
    } catch (err) {
      this.store.transition('offline', 'transport');
      this.ui.onError?.(`backend unreachable: ${err.message}`, { preserveText: text });
      return;
    }

    let firstSayAt = null;
    let fullSay = '';
    try {
      for await (const { event, data } of sseStream(response)) {
        if (event === 'say') {
          if (firstSayAt === null) {
            firstSayAt = performance.now();
            this.store.reportMetrics([{ metric: 'first_say', value_ms: firstSayAt - t0 }]);
          }
          fullSay += (fullSay ? ' ' : '') + data.text;
          this.ui.onReply?.(fullSay, {});
          if (modality === 'voice' && this.tts.available && !this.capture.muted) this.tts.enqueue(data.text);
        } else if (event === 'state') {
          this.store.mirror(data.state);
        } else if (event === 'route') {
          this.ui.onRoute?.(data);
        } else if (event === 'meta') {
          this.conversationId = data.conversationId;
          localStorage.setItem('rabit.conversationId', this.conversationId);
        } else if (event === 'error') {
          this.ui.onError?.(`${data.message} (ref ${data.reference})`);
        }
      }
    } catch (err) {
      this.store.transition('reconnecting', 'transport');
      this.ui.onError?.(`stream interrupted: ${err.message}`);
    }
    if (['thinking', 'creating_plan'].includes(this.store.state)) this.store.mirror('ready');
    if (modality === 'voice' && fullSay) {
      this.store.reportMetrics([{ metric: 'e2e_turn', value_ms: performance.now() - t0 }]);
    }
  }
}
