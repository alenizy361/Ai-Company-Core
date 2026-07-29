// SpeechToTextProvider — browser Web Speech implementation (ar/en). Pluggable:
// a server-proxied streaming provider (e.g. Deepgram) can replace this behind
// the same interface when its key is configured (see /api/health voiceProviders).
export class WebSpeechSTT {
  constructor(store) {
    this.store = store;
    this.rec = null;
    this.running = false;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.available = !!SR && window.isSecureContext;
    this.SR = SR;
  }

  /** Starts one recognition turn. Callbacks: onInterim(text), resolves {text, lang} on final, null on abort/error. */
  start(lang, onInterim) {
    if (!this.available) {
      this.store.transition('failed', 'stt');
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const rec = new this.SR();
      this.rec = rec;
      this.running = true;
      rec.lang = lang === 'ar' ? 'ar-SA' : 'en-US';
      rec.interimResults = true;
      rec.continuous = false;
      let finalText = '';
      let sawSpeech = false;

      rec.onresult = (e) => {
        let interim = '';
        for (const result of e.results) {
          if (result.isFinal) finalText += result[0].transcript;
          else interim += result[0].transcript;
        }
        if (interim && !sawSpeech) {
          sawSpeech = true;
          this.store.transition('transcribing', 'stt');
        }
        onInterim(finalText + interim);
      };
      rec.onerror = (e) => {
        this.running = false;
        if (e.error === 'no-speech' || e.error === 'aborted') resolve(finalText.trim() ? { text: finalText.trim() } : null);
        else {
          this.store.transition('failed', 'stt');
          resolve(null);
        }
      };
      rec.onend = () => {
        this.running = false;
        resolve(finalText.trim() ? { text: finalText.trim() } : null);
      };
      try {
        rec.start();
      } catch {
        this.running = false;
        resolve(null);
      }
    });
  }

  stop() {
    if (this.rec && this.running) {
      try { this.rec.stop(); } catch { /* already stopped */ }
    }
  }

  abort() {
    if (this.rec && this.running) {
      try { this.rec.abort(); } catch { /* already stopped */ }
    }
  }
}
