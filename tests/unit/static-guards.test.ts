// Static source guards over web/: (a) innerHTML-family is banned (model text
// must never reach the DOM as markup), (b) CSS uses logical properties only,
// (c) no previous product identity anywhere in the client.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const WEB = resolve(import.meta.dirname, '..', '..', 'web');

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

test('no innerHTML/outerHTML/insertAdjacentHTML anywhere in web/', () => {
  const offenders: string[] = [];
  for (const file of walk(WEB)) {
    if (!file.endsWith('.js') && !file.endsWith('.html')) continue;
    const content = readFileSync(file, 'utf8');
    content.split('\n').forEach((line, i) => {
      if (/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML/.test(line)) {
        offenders.push(`${relative(WEB, file)}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test('CSS uses logical properties only (no physical direction)', () => {
  const PHYSICAL = /(?:^|[^-\w])(margin-left|margin-right|padding-left|padding-right|border-left|border-right|text-align:\s*(?:left|right)\b|float:|(?:^|\s)(?:left|right)\s*:)/;
  const offenders: string[] = [];
  for (const file of walk(WEB)) {
    if (!file.endsWith('.css')) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (PHYSICAL.test(line)) offenders.push(`${relative(WEB, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('no previous product identity in web/', () => {
  const offenders: string[] = [];
  for (const file of walk(WEB)) {
    const content = readFileSync(file, 'utf8');
    content.split('\n').forEach((line, i) => {
      // rabit.* localStorage keys inside prefs.js are the migration that
      // ERASES the old identity — the only allowed occurrence.
      if (/rabit|رابت|رابِت|jarvis/i.test(line) && !file.endsWith('core/prefs.js')) {
        offenders.push(`${relative(WEB, file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});
