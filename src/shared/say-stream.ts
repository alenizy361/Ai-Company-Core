// Incremental extraction of the speakable "say" value while a converse-
// contract JSON reply is still streaming. Emits only DECODED, STABLE text:
// escape sequences are never split (the scanner waits for their completion),
// so RTL/Arabic content streams without corruption.
//
// Degradation is honest: replies that are not contract JSON (e.g. the mock
// notice, or a model ignoring the contract) stream through as raw text —
// exactly what the non-streaming fallback would have shown.

const SAY_KEY_RE = /"say"\s*:\s*"/;

export class SayStreamExtractor {
  private raw = '';
  private mode: 'pending' | 'json' | 'raw' | 'closed' = 'pending';
  /** index into raw of the next unscanned char of the say value */
  private scanPos = 0;
  /** decoded say text emitted so far */
  private emittedText = '';
  /** raw-mode: how much of raw has been emitted */
  private rawEmitted = 0;

  get emitted(): string {
    return this.emittedText;
  }

  get closed(): boolean {
    return this.mode === 'closed';
  }

  /** Feed a model delta; returns newly-stable decoded text ('' if none yet). */
  push(delta: string): string {
    this.raw += delta;
    if (this.mode === 'pending') {
      const lead = this.raw.trimStart();
      if (lead.length > 0 && !lead.startsWith('{')) {
        this.mode = 'raw';
      } else {
        const m = SAY_KEY_RE.exec(this.raw);
        if (m) {
          this.mode = 'json';
          this.scanPos = m.index + m[0].length;
        }
      }
    }
    if (this.mode === 'raw') {
      const out = this.raw.slice(this.rawEmitted);
      this.rawEmitted = this.raw.length;
      this.emittedText += out;
      return out;
    }
    if (this.mode !== 'json') return '';
    return this.scanValue();
  }

  /** Stream ended: release anything held back. */
  finish(): string {
    if (this.mode === 'json') return this.scanValue(true);
    if (this.mode === 'pending') {
      // Never found a say key; nothing was emitted. The caller's full-text
      // parse decides what to show — do not guess here.
      return '';
    }
    return '';
  }

  private scanValue(atEnd = false): string {
    let out = '';
    while (this.scanPos < this.raw.length) {
      const ch = this.raw[this.scanPos];
      if (ch === '"') {
        this.mode = 'closed';
        this.scanPos++;
        break;
      }
      if (ch === '\\') {
        const next = this.raw[this.scanPos + 1];
        if (next === undefined) {
          if (atEnd) this.scanPos++; // dangling backslash at stream end — drop it
          break; // wait for the escape to complete
        }
        if (next === 'u') {
          const hex = this.raw.slice(this.scanPos + 2, this.scanPos + 6);
          if (hex.length < 4) {
            if (atEnd) this.scanPos = this.raw.length; // incomplete \u at end — drop
            break;
          }
          const code = Number.parseInt(hex, 16);
          out += Number.isNaN(code) ? '' : String.fromCharCode(code);
          this.scanPos += 6;
          continue;
        }
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
        out += map[next] ?? next;
        this.scanPos += 2;
        continue;
      }
      out += ch;
      this.scanPos++;
    }
    this.emittedText += out;
    return out;
  }
}

/**
 * Groups streamed text into sentence-safe speakable segments (Arabic-aware)
 * so TTS can start before the reply finishes. Segments under minChars merge
 * with their successor to avoid choppy speech.
 */
export class SentenceBuffer {
  /** text with no terminator yet */
  private buf = '';
  /** terminated sentences held back until they reach minChars */
  private pending = '';
  private readonly minChars: number;

  constructor(minChars = 20) {
    this.minChars = minChars;
  }

  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    for (;;) {
      const m = /[.!?؟…\n]+\s*/.exec(this.buf);
      if (!m) break;
      const end = m.index + m[0].length;
      if (end >= this.buf.length && !/\s$/.test(this.buf)) {
        // The terminator is the current last char — it may still be
        // mid-ellipsis or mid "?!"; wait for more input (flush() covers EOS).
        break;
      }
      this.pending += this.buf.slice(0, end);
      this.buf = this.buf.slice(end);
      if (this.pending.trim().length >= this.minChars) {
        out.push(this.pending.trim());
        this.pending = '';
      }
    }
    return out;
  }

  flush(): string {
    const rest = `${this.pending}${this.buf}`.trim();
    this.pending = '';
    this.buf = '';
    return rest;
  }
}
