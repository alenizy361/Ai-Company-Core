// Key-gated external providers (server-proxied). Selected by the controller
// ONLY when /api/health reports them active — otherwise the browser-native
// fallbacks stay in charge. Keys never reach this code; the server relays.

/** Turn-based Deepgram STT: record one utterance (VAD-ended), POST to the
 * server relay, get the final transcript. Same interface as WebSpeechSTT. */
export class DeepgramTurnSTT {
  constructor(store, capture, turnConfig) {
    this.store = store;
    this.capture = capture;
    this.turn = turnConfig ?? { silenceMs: 900, minSpeechMs: 200 };
    this.available = typeof MediaRecorder !== 'undefined';
    this.recorder = null;
  }

  start(lang, onInterim) {
    if (!this.available || !this.capture.stream) return Promise.resolve(null);
    return new Promise((resolve) => {
      const chunks = [];
      const recorder = new MediaRecorder(this.capture.stream, { mimeType: 'audio/webm' });
      this.recorder = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

      let sawSpeech = false;
      let silentSince = null;
      const startedAt = performance.now();
      const poll = setInterval(() => {
        const amp = this.capture.amplitude();
        if (amp > 0.12) {
          if (!sawSpeech) {
            sawSpeech = true;
            this.store.transition('transcribing', 'stt');
            onInterim?.('…');
          }
          silentSince = null;
        } else if (sawSpeech) {
          silentSince ??= performance.now();
          if (performance.now() - silentSince > this.turn.silenceMs) stop();
        }
        if (performance.now() - startedAt > 15000) stop();
      }, 80);

      const stop = () => {
        clearInterval(poll);
        if (recorder.state !== 'inactive') recorder.stop();
      };
      this.stop = stop;
      this.abort = () => { clearInterval(poll); chunks.length = 0; if (recorder.state !== 'inactive') recorder.stop(); };

      recorder.onstop = async () => {
        clearInterval(poll);
        if (!chunks.length || !sawSpeech) return resolve(null);
        const session = this.store.session;
        try {
          const res = await fetch(
            `/api/voice/stt?session=${session.id}&token=${session.token}&lang=${lang}`,
            { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Blob(chunks, { type: 'audio/webm' }) },
          );
          if (!res.ok) {
            this.store.transition('failed', 'stt');
            return resolve(null);
          }
          const data = await res.json();
          resolve(data.text ? { text: data.text } : null);
        } catch {
          this.store.transition('failed', 'stt');
          resolve(null);
        }
      };
      recorder.start(250);
    });
  }
}

/** Segment language for the server voice: dominant script, never any-char
 * (one Arabic name inside an English sentence must not flip the voice). */
function segmentLang(text) {
  const arabic = (text.match(/[؀-ۿݐ-ݿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return arabic > latin ? 'ar' : 'en';
}

/** Fish Audio TTS via the server relay: real <audio> playback drives the
 * speaking state and a WebAudio analyser provides the REAL output amplitude. */
export class FishAudioTTS {
  constructor(store) {
    this.store = store;
    this.queue = [];
    this.playing = false;
    // busy covers the whole synthesize->play->end cycle: `playing` only
    // becomes true at audio.onplaying, so gating _next() on it alone lets a
    // second sentence start fetching mid-flight and OVERLAP the first.
    this.busy = false;
    // Generation epoch: interrupt() bumps it, and _next() re-checks it after
    // EVERY await. Without this, an interrupt landing while a fetch was in
    // flight left that _next() parked; it then resumed, played the stale
    // clip, and its onended chain drained the NEXT turn's queue in parallel
    // with the fresh chain — two voices at once.
    this.gen = 0;
    this.fetchCtrl = null;
    this.available = true;
    this.audio = null;
    this.currentText = '';
    this.onRemainder = null;
    this.audioCtx = null;
    this.analyser = null;
    this.buf = null;
  }

  amplitude() {
    if (!this.playing || !this.analyser) return 0;
    this.analyser.getByteFrequencyData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i];
    return Math.min(1, sum / this.buf.length / 60);
  }

  enqueue(text) {
    this.queue.push(text);
    if (!this.busy) this._next();
    return true;
  }

  async _next() {
    const gen = this.gen;
    const text = this.queue.shift();
    if (text === undefined) {
      this.busy = false;
      this.playing = false;
      if (['speaking', 'generating_speech'].includes(this.store.state)) this.store.transition('ready', 'playback');
      return;
    }
    this.busy = true;
    this.store.transition('generating_speech', 'tts');
    const session = this.store.session;
    try {
      this.fetchCtrl = new AbortController();
      const res = await fetch(`/api/voice/tts?session=${session.id}&token=${session.token}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, lang: segmentLang(text) }),
        signal: this.fetchCtrl.signal,
      });
      if (gen !== this.gen) return; // interrupted while fetching — stale chain dies here
      if (!res.ok) throw new Error(`tts ${res.status}`);
      const blob = await res.blob();
      if (gen !== this.gen) return;
      const audio = new Audio(URL.createObjectURL(blob));
      this.audio = audio;
      this.currentText = text;
      this.audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
      const src = this.audioCtx.createMediaElementSource(audio);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 128;
      src.connect(this.analyser);
      this.analyser.connect(this.audioCtx.destination);
      this.buf = new Uint8Array(this.analyser.frequencyBinCount);
      audio.onplaying = () => {
        if (gen !== this.gen) return;
        this.playing = true;
        this.store.transition('speaking', 'playback');
      };
      audio.onended = () => {
        URL.revokeObjectURL(audio.src);
        if (gen !== this.gen) return;
        this.playing = false;
        this._next();
      };
      audio.onerror = () => {
        if (gen !== this.gen) return;
        this.playing = false;
        this.busy = false;
        this.store.transition('failed', 'tts');
      };
      if (gen !== this.gen) return;
      await audio.play();
    } catch (err) {
      if (gen !== this.gen || err?.name === 'AbortError') return; // interrupted, not failed
      this.playing = false;
      this.busy = false;
      this.store.transition('failed', 'tts');
    }
  }

  interrupt() {
    const startedAt = performance.now();
    this.gen += 1; // every parked _next() dies at its next epoch check
    this.fetchCtrl?.abort();
    const wasPlaying = this.playing;
    let remainder = '';
    if (this.audio) {
      if (wasPlaying) {
        const ratio = this.audio.duration ? this.audio.currentTime / this.audio.duration : 0;
        remainder = ratio < 0.9 ? this.currentText.slice(Math.floor(this.currentText.length * ratio)) : '';
      }
      // Always detach + pause — a created-but-not-yet-playing clip would
      // otherwise start speaking AFTER the interrupt (over the next turn).
      this.audio.onplaying = null;
      this.audio.onended = null;
      this.audio.onerror = null;
      try { this.audio.pause(); } catch { /* never started */ }
      this.audio = null;
    }
    const pending = this.queue.splice(0);
    this.playing = false;
    this.busy = false;
    if (wasPlaying) {
      this.store.transition('interrupted', 'playback');
      const unspoken = [remainder, ...pending].filter(Boolean).join(' ');
      if (unspoken && this.onRemainder) this.onRemainder(unspoken);
    }
    return { wasPlaying, stopMs: performance.now() - startedAt };
  }
}
