// Acceptance guard: the en/ar dictionaries stay in exact key parity with no
// empty values, and interpolation placeholders match across languages.
import { test } from 'node:test';
import assert from 'node:assert';
import en from '../../web/js/i18n/en.js';
import ar from '../../web/js/i18n/ar.js';

test('en/ar dictionaries: identical key sets, no empty values', () => {
  const enKeys = Object.keys(en).sort();
  const arKeys = Object.keys(ar).sort();
  assert.deepEqual(arKeys, enKeys, 'key sets differ');
  for (const [k, v] of [...Object.entries(en), ...Object.entries(ar)]) {
    assert.ok(typeof v === 'string' && v.trim().length > 0, `empty value for ${k}`);
  }
});

test('interpolation placeholders match between languages', () => {
  for (const key of Object.keys(en)) {
    const placeholders = (s: string): string[] => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
    assert.deepEqual(
      placeholders((ar as Record<string, string>)[key]),
      placeholders((en as Record<string, string>)[key]),
      `placeholder mismatch in ${key}`,
    );
  }
});

test('no previous product identity inside dictionary values', () => {
  for (const dict of [en, ar]) {
    for (const [k, v] of Object.entries(dict)) {
      assert.ok(!/rabit|رابت|رابِت|jarvis/i.test(v as string), `brand leak in ${k}`);
    }
  }
});
