// Speakable-text transformation: the written response is preserved verbatim
// in the interface, but what goes to TTS must be natural speech. Code blocks,
// raw URLs, file paths, and long identifiers are unspeakable — they are
// dropped or replaced with short natural phrases. Pure functions; the
// streaming wrapper handles fences that span deltas.

/** Cleanup applied to one completed prose sentence before TTS. */
export function speakableSentence(text: string): string {
  let out = text;
  // Inline code spans: speak the content only when it is a short word-like
  // token (a command or name); otherwise elide it.
  out = out.replace(/`([^`\n]{1,24})`/g, (_m, inner: string) => (/^[\w./ -]+$/.test(inner) ? inner : ''));
  out = out.replace(/`[^`]*`/g, '');
  // URLs -> their host ("example.com").
  out = out.replace(/https?:\/\/([^\s/,)"']+)[^\s,)"']*/g, '$1');
  // Markdown emphasis/heading markers read as noise.
  out = out.replace(/[*_#>]{1,3}/g, '');
  // File paths -> final segment ("config.ts").
  out = out.replace(/(?:[\w.-]+\/){2,}([\w.-]+)/g, '$1');
  // Long opaque identifiers (ids, hashes) are unspeakable.
  out = out.replace(/\b[a-zA-Z0-9_-]{20,}\b/g, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Streaming fence suppressor: feed raw response deltas, receive prose-only
 * deltas (fenced code blocks removed even when the fence spans chunks).
 * The written transcript keeps the original text — this stream feeds ONLY
 * sentence segmentation for TTS.
 */
export class SpeakableStream {
  private buf = '';
  private inFence = false;

  push(delta: string): string {
    this.buf += delta;
    let out = '';
    for (;;) {
      if (this.inFence) {
        const close = this.buf.indexOf('```');
        if (close === -1) {
          this.buf = this.buf.slice(-2); // keep a possible split ``` marker
          return out;
        }
        this.buf = this.buf.slice(close + 3);
        this.inFence = false;
        continue;
      }
      const open = this.buf.indexOf('```');
      if (open === -1) {
        // Hold back a possible split marker at the very end.
        const safe = this.buf.length - 2;
        if (safe > 0) {
          out += this.buf.slice(0, safe);
          this.buf = this.buf.slice(safe);
        }
        return out;
      }
      out += this.buf.slice(0, open);
      this.buf = this.buf.slice(open + 3);
      this.inFence = true;
    }
  }

  /** Stream ended: flush whatever prose remains (an unclosed fence is dropped). */
  flush(): string {
    const rest = this.inFence ? '' : this.buf;
    this.buf = '';
    this.inFence = false;
    return rest;
  }
}
