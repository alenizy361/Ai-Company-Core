// The claude CLI must be findable even under a minimal service PATH (systemd
// user units), otherwise a logged-in machine silently degrades to mock mode.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveClaudeBin } from '../../src/adapters/claude-cli.ts';

test('resolveClaudeBin: override > PATH > user-local installs > bare fallback', () => {
  const base = mkdtempSync(join(tmpdir(), 'rabit-bin-'));
  try {
    const pathDir = join(base, 'pathdir');
    const home = join(base, 'home');
    mkdirSync(pathDir, { recursive: true });
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });

    // Nothing anywhere -> bare name (spawn fails loudly -> honest mock fallback).
    assert.equal(resolveClaudeBin({ PATH: pathDir, HOME: home }), 'claude');

    // ~/.local/bin/claude is found even when PATH misses it (the systemd case).
    const localBin = join(home, '.local', 'bin', 'claude');
    writeFileSync(localBin, '#!/bin/sh\n');
    assert.equal(resolveClaudeBin({ PATH: pathDir, HOME: home }), localBin);

    // A PATH hit wins over the probed install locations.
    const onPath = join(pathDir, 'claude');
    writeFileSync(onPath, '#!/bin/sh\n');
    assert.equal(resolveClaudeBin({ PATH: pathDir, HOME: home }), onPath);

    // Explicit RABIT_CLAUDE_BIN override wins over everything.
    assert.equal(
      resolveClaudeBin({ RABIT_CLAUDE_BIN: localBin, PATH: pathDir, HOME: home }),
      localBin,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
