// Tests AtspiHost's protocol handling end-to-end over a REAL python3 child
// process — but never real AT-SPI and never ../../src/desktop-bridge/atspi/
// helper.py itself. AtspiHostDeps.helperPath is pointed at a small stub
// fixture (tests/fixtures/atspi-stub-helper.py) implementing the same NDJSON
// protocol with canned responses, so this exercises the real Node<->Python
// IPC without depending on AT-SPI being installed/working in CI.
import { test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AtspiHost } from '../../src/desktop-bridge/atspi/host.ts';

const STUB_HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'atspi-stub-helper.py');

function newHost(): AtspiHost {
  return new AtspiHost({ pythonBin: 'python3', helperPath: STUB_HELPER_PATH });
}

test('successful round-trip resolves with the right data', async () => {
  const host = newHost();
  try {
    const result = await host.call('ping', {}, 2000);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { pong: true });
  } finally {
    host.close();
  }
});

test('a "fail" action resolves with ok:false and the stub\'s error message', async () => {
  const host = newHost();
  try {
    const result = await host.call('fail', {}, 2000);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'stub failure');
  } finally {
    host.close();
  }
});

test('an action the stub never answers times out cleanly instead of hanging', async () => {
  const host = newHost();
  try {
    await assert.rejects(
      host.call('mystery_action', {}, 500),
      /AT-SPI request timed out after 500ms/,
    );
  } finally {
    host.close();
  }
});

test('close() cleans up the process, and a call after close() respawns correctly', async () => {
  const host = newHost();
  try {
    const first = await host.call('ping', {}, 2000);
    assert.equal(first.ok, true);

    host.close();

    const second = await host.call('ping', {}, 2000);
    assert.equal(second.ok, true);
    assert.deepEqual(second.data, { pong: true });
  } finally {
    host.close();
  }
});

test('multiple in-flight requests each resolve to their own response, never cross-wired', async () => {
  const host = newHost();
  try {
    const [pingResult, failResult] = await Promise.all([
      host.call('ping', {}, 2000),
      host.call('fail', {}, 2000),
    ]);
    assert.equal(pingResult.ok, true);
    assert.equal(failResult.ok, false);
    assert.equal(failResult.error, 'stub failure');
  } finally {
    host.close();
  }
});
