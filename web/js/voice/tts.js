// TextToSpeechProvider + AudioPlaybackController — speechSynthesis
// implementation with a segment queue and hard barge-in (cancel <200ms).
// 'speaking' is claimed only from real utterance onstart; 'ready' only after
// real onend/cancel. The unspoken remainder is preserved for the transcript.
export class SpeechSynthesisTTS {
  constructor(store) {
    this.store = store;
    this.queue = [];
    this.playing = false;
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
      if (['speaking', 'generating_speech'].includes(this.store.state)) this.store.transition('ready', 'playback');
      return;
    }
    this.store.transition('generating_speech', 'tts');
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = /[؀-ۿ]/.test(text) ? 'ar-SA' : 'en-US';
    utterance.rate = 1.02;
    this.currentText = text;
    this.spokenChars = 0;
    utterance.onstart = () => {
      this.playing = true;
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
      this._next();
    };
    utterance.onerror = () => {
      this.playing = false;
      this.store.transition('failed', 'tts');
    };
    speechSynthesis.speak(utterance);
  }

  /** Barge-in: stop immediately, preserve the unspoken remainder. */
  interrupt() {
    const startedAt = performance.now();
    const remainder = this.playing ? this.currentText.slice(this.spokenChars) : '';
    const pendingQueue = this.queue.splice(0);
    try { speechSynthesis.cancel(); } catch { /* nothing playing */ }
    const wasPlaying = this.playing;
    this.playing = false;
    if (wasPlaying) {
      this.store.transition('interrupted', 'playback');
      const unspoken = [remainder, ...pendingQueue].filter(Boolean).join(' ');
      if (unspoken && this.onRemainder) this.onRemainder(unspoken);
    }
    return { wasPlaying, stopMs: performance.now() - startedAt };
  }
}
