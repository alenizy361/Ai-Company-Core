// AudioCaptureProvider: real microphone via getUserMedia with echo
// cancellation/noise suppression requested; AnalyserNode drives the orb's
// input amplitude; hard mute stops all tracks (nothing captures while muted).
export class AudioCapture {
  constructor(store) {
    this.store = store;
    this.stream = null;
    this.audioCtx = null;
    this.analyser = null;
    this.buf = null;
    this.muted = false;
  }

  get active() {
    return !!this.stream && this.stream.getTracks().some((t) => t.readyState === 'live');
  }

  /** Real amplitude 0..1 from the live mic, 0 when not capturing. */
  amplitude() {
    if (!this.analyser || !this.active || this.muted) return 0;
    this.analyser.getByteFrequencyData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i];
    return Math.min(1, sum / this.buf.length / 70);
  }

  async start() {
    if (this.muted) return false;
    if (this.active) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.store.transition('failed', 'capture');
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      this.store.transition(err?.name === 'NotAllowedError' ? 'permission_required' : 'failed', 'capture');
      return false;
    }
    this.audioCtx = this.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume().catch(() => {});
    const src = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    src.connect(this.analyser);
    this.buf = new Uint8Array(this.analyser.frequencyBinCount);
    return true;
  }

  stop() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.analyser = null;
  }

  /** Hard mute: physically stops capture. */
  setMuted(muted) {
    this.muted = muted;
    if (muted) {
      this.stop();
      this.store.transition('muted', 'capture');
    } else if (this.store.state === 'muted') {
      this.store.transition('ready', 'capture');
    }
  }
}
