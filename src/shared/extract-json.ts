// Tolerant extraction of the first balanced top-level JSON object from model
// output. Models occasionally wrap JSON in fences or prose; we accept that,
// but the parsed object itself must be valid JSON.
export function extractFirstJsonObject(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const start = text.indexOf('{');
  if (start === -1) return { ok: false, error: 'no JSON object found in output' };

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return { ok: true, value: JSON.parse(candidate) };
        } catch (err) {
          return { ok: false, error: `unbalanced-quote JSON: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
    }
  }
  return { ok: false, error: 'JSON object never closed' };
}
