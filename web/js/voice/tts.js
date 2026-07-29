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
    this.available = 'speechSynthesis' in window;
    this.envelope = 0; // synthetic output level, nonzero ONLY while really playing
    this._tick = null;
  }

  amplitude() {
    return this.playing ? this.envelope : 0;
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
      this.store.transition('speaking', 'playback');
      clearInterval(this._tick);
      this._tick = setInterval(() => {
        this.envelope = 0.5 + Math.abs(Math.sin(Date.now() / 130)) * 0.5;
      }, 60);
    };
    utterance.onboundary = (e) => {
      if (typeof e.charIndex === 'number') this.spokenChars = e.charIndex;
    };
    utterance.onend = () => {
      clearInterval(this._tick);
      this.envelope = 0;
      this.playing = false;
      this._next();
    };
    utterance.onerror = () => {
      clearInterval(this._tick);
      this.envelope = 0;
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
    clearInterval(this._tick);
    this.envelope = 0;
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
