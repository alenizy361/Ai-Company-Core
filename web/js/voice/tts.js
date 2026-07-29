// TextToSpeechProvider + AudioPlaybackController — speechSynthesis
// implementation with a segment queue and hard barge-in (cancel <200ms).
// 'speaking' is claimed only from real utterance onstart; 'ready' only after
// real onend/cancel. The unspoken remainder is preserved for the transcript.
export class SpeechSynthesisTTS {
  constructor(store) {
    this.store = store;
    this.queue = [];
    this.playing = false;
    this.pending = false;
    this.currentText = '';
    this.spokenChars = 0;
    this.onRemainder = null;
    this.onBoundary = null; // (charIndex) => void — REAL word boundaries
    this._boundaryAt = 0;
    // Voices can load asynchronously; prime the list and track changes.
    if ('speechSynthesis' in window) {
      speechSynthesis.getVoices();
      speechSynthesis.addEventListener?.('voiceschanged', () => speechSynthesis.getVoices());
    }
  }

  /**
   * Honest availability: speechSynthesis with ZERO voices (common in Linux
   * browsers) produces pure silence — that must surface as unavailable, not
   * as a fake "speaking" state.
   */
  get available() {
    return 'speechSynthesis' in window && speechSynthesis.getVoices().length > 0;
  }

  /**
   * Anything queued, committed to the engine, or sounding — the barge-in
   * gesture keys off this. `pending` covers the speak()->onstart synthesis
   * window, where the segment has left the queue but is not yet audible.
   */
  get busy() {
    return this.playing || this.pending || this.queue.length > 0;
  }

  /**
   * speechSynthesis exposes no output level, so the ONLY honest per-moment
   * signal is the real word-boundary event: amplitude decays from each real
   * onboundary instead of a fabricated oscillator. Fish Audio replaces this
   * with a true AnalyserNode level.
   */
  amplitude() {
    if (!this.playing) return 0;
    const since = performance.now() - this._boundaryAt;
    return Math.max(0, 0.7 - since / 400);
  }

  enqueue(text) {
    if (!this.available) return false;
    this.queue.push(text);
    if (!this.playing) this._next();
    return true;
  }

  _next() {
    const text = this.queue.shift();
    if (text === undefined) {
      this.playing = false;
      this.pending = false;
      if (['speaking', 'generating_speech'].includes(this.store.state)) this.store.transition('ready', 'playback');
      return;
    }
    this.pending = true;
    this.store.transition('generating_speech', 'tts');
    const utterance = new SpeechSynthesisUtterance(text);
    // Dominant script decides the voice — a single Arabic word inside an
    // English sentence must not flip the whole sentence to an Arabic voice.
    const arabicChars = (text.match(/[؀-ۿݐ-ݿ]/g) ?? []).length;
    const latinChars = (text.match(/[A-Za-z]/g) ?? []).length;
    const lang = arabicChars > latinChars ? 'ar' : 'en';
    utterance.lang = lang === 'ar' ? 'ar-SA' : 'en-US';
    // Pick an explicit matching voice when one exists; the browser default
    // may be the wrong language entirely.
    const voice = speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith(lang));
    if (voice) utterance.voice = voice;
    utterance.rate = 1.02;
    this.currentText = text;
    this.spokenChars = 0;
    utterance.onstart = () => {
      this.playing = true;
      this.pending = false;
      this._boundaryAt = performance.now();
      this.store.transition('speaking', 'playback');
    };
    utterance.onboundary = (e) => {
      if (typeof e.charIndex === 'number') {
        this.spokenChars = e.charIndex;
        this._boundaryAt = performance.now();
        this.onBoundary?.(e.charIndex);
      }
    };
    utterance.onend = () => {
      this.playing = false;
      this.pending = false;
      this._next();
    };
    utterance.onerror = () => {
      this.playing = false;
      this.pending = false;
      this.store.transition('failed', 'tts');
    };
    speechSynthesis.speak(utterance);
  }

  /** Barge-in: stop immediately, preserve the unspoken remainder. */
  interrupt() {
    const startedAt = performance.now();
    const wasPlaying = this.playing;
    // Unspoken content includes a segment committed to the engine but not
    // yet audible (pending) — dropping it silently would lose transcript truth.
    const remainder = wasPlaying ? this.currentText.slice(this.spokenChars) : this.pending ? this.currentText : '';
    const pendingQueue = this.queue.splice(0);
    try { speechSynthesis.cancel(); } catch { /* nothing playing */ }
    const wasPending = this.pending;
    this.playing = false;
    this.pending = false;
    if (wasPlaying) {
      this.store.transition('interrupted', 'playback');
    } else if (wasPending && ['generating_speech', 'speaking'].includes(this.store.state)) {
      // Killed during synthesis: nothing will drain the queue anymore, so
      // release the state machine here.
      this.store.transition('ready', 'playback');
    }
    const unspoken = [remainder, ...pendingQueue].filter(Boolean).join(' ');
    if (unspoken && this.onRemainder) this.onRemainder(unspoken);
    return { wasPlaying, stopMs: performance.now() - startedAt };
  }
}
