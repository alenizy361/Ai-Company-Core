// Stable-prefix extraction of the streamed "say" value: escape sequences are
// never split, Arabic survives byte-chunking, non-JSON replies degrade to raw
// passthrough, and sentence grouping stays speakable.
import { test } from 'node:test';
import assert from 'node:assert';
import { SayStreamExtractor, SentenceBuffer } from '../../src/shared/say-stream.ts';

function feed(extractor: SayStreamExtractor, full: string, chunkSize: number): string {
  let out = '';
  for (let i = 0; i < full.length; i += chunkSize) out += extractor.push(full.slice(i, i + chunkSize));
  out += extractor.finish();
  return out;
}

test('extracts decoded say across every possible chunk boundary', () => {
  const obj = { route: 'reply', say: 'Hello\nworld — مرحبا "بالعالم" السلام.' };
  const full = JSON.stringify(obj);
  for (const size of [1, 2, 3, 5, 7, 64]) {
    const got = feed(new SayStreamExtractor(), full, size);
    assert.equal(got, obj.say, `chunk size ${size}`);
  }
});

test('escaped unicode is decoded, never split mid-sequence', () => {
  const full = '{"route":"reply","say":"A\\u0627B\\u0644C"}';
  for (const size of [1, 3, 4]) {
    const extractor = new SayStreamExtractor();
    const got = feed(extractor, full, size);
    assert.equal(got, 'AاBلC', `chunk size ${size}`);
    assert.ok(extractor.closed);
  }
});

test('emissions are stable prefixes (never retracted)', () => {
  const full = '{"route":"reply","say":"one two three four"}';
  const extractor = new SayStreamExtractor();
  let acc = '';
  for (const ch of full) {
    const inc = extractor.push(ch);
    assert.ok(inc.length >= 0);
    acc += inc;
    assert.ok('one two three four'.startsWith(acc), `prefix violated at "${acc}"`);
  }
  acc += extractor.finish();
  assert.equal(acc, 'one two three four');
});

test('non-JSON reply streams through raw (mock-mode degradation)', () => {
  const raw = 'MOCK MODE: no real model is configured.';
  const extractor = new SayStreamExtractor();
  const got = feed(extractor, raw, 8);
  assert.equal(got, raw);
});

test('JSON without a say key emits nothing (caller full-parse decides)', () => {
  const extractor = new SayStreamExtractor();
  assert.equal(feed(extractor, '{"route":"clarify"}', 4), '');
  assert.equal(extractor.emitted, '');
});

test('sentence buffer: merges short sentences, Arabic terminators, flush remainder', () => {
  const sb = new SentenceBuffer(20);
  const out: string[] = [];
  for (const chunk of ['One. ', 'Two! ', 'ثلاثة؟ ', 'And a much longer sentence follows here. ', 'tail']) {
    out.push(...sb.push(chunk));
  }
  assert.ok(out.length >= 1);
  assert.ok(out[0].includes('One.') && out[0].includes('Two!'), 'short sentences merged');
  assert.equal(sb.flush(), 'tail');
  // A terminator as the very last char is held until flush, not emitted early.
  const sb2 = new SentenceBuffer(5);
  assert.deepEqual(sb2.push('Wait.'), []);
  assert.equal(sb2.flush(), 'Wait.');
});
