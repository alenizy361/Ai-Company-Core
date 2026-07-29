// Mandatory acceptance test 1 (branding): no previous product identity may
// appear anywhere user-visible or model-facing. The only permitted matches
// are the two explicit legacy-migration sites that exist to ERASE the old
// name from existing deployments.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'var']);
const EXTENSIONS = /\.(ts|js|mjs|md|json|sql|sh|html|css|yml|yaml|txt)$/;
// The only allowed matches are the explicit legacy-migration sites that exist
// to ERASE the old name from existing deployments.
const ALLOWED: Record<string, RegExp> = {
  'src/shared/seed.ts': /UPDATE orgs SET name = 'SIRA' WHERE id = \? AND name = 'Rabit AI Company'/,
  'scripts/install-sira.sh': /for old in rabit-api rabit-worker|migrating old \$old\.service/,
  'web/js/core/prefs.js': /rabit\.(lang|conversationId)|previous product/,
  'README.md': /removes old `rabit-\*` systemd units|`RABIT_\*` variables, rename them/,
  'tests/unit/branding.test.ts': /.*/, // this file names the patterns it hunts
  'tests/unit/static-guards.test.ts': /rabit|jarvis/i, // ditto
  'tests/unit/i18n-parity.test.ts': /rabit|jarvis/i, // ditto
  'tests/ui/acceptance.test.ts': /rabit|jarvis/i, // ditto (live-DOM assertions)
};

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walk(full);
    } else if (EXTENSIONS.test(entry)) {
      yield full;
    }
  }
}

test('branding: no RABIT/Jarvis identity outside explicit legacy-migration sites', () => {
  const offenders: string[] = [];
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file);
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      if (/rabit|jarvis/i.test(line)) {
        const allowed = ALLOWED[rel];
        if (!allowed || !allowed.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `previous product identity found:\n${offenders.join('\n')}`);
});
