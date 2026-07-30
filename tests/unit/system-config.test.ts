// Phase 2 security: the API server must bind to loopback by default — an
// unauthenticated API (the default when OWNER_TOKEN is unset, meant for a
// single-owner local deployment) must never be reachable from the network
// unless the owner explicitly opts in. loadSystemConfig() is the single
// place that resolves the bind host; this proves the default and the
// SIRA_HOST override both resolve as intended.
import { test } from 'node:test';
import assert from 'node:assert';
import { loadSystemConfig } from '../../src/shared/config.ts';

test('loadSystemConfig: defaults to loopback-only when SIRA_HOST is unset', () => {
  const prev = process.env.SIRA_HOST;
  delete process.env.SIRA_HOST;
  try {
    const cfg = loadSystemConfig();
    assert.equal(cfg.host, '127.0.0.1');
  } finally {
    if (prev !== undefined) process.env.SIRA_HOST = prev; else delete process.env.SIRA_HOST;
  }
});

test('loadSystemConfig: SIRA_HOST overrides the default when the owner explicitly opts in', () => {
  const prev = process.env.SIRA_HOST;
  process.env.SIRA_HOST = '0.0.0.0';
  try {
    const cfg = loadSystemConfig();
    assert.equal(cfg.host, '0.0.0.0');
  } finally {
    if (prev !== undefined) process.env.SIRA_HOST = prev; else delete process.env.SIRA_HOST;
  }
});

test('loadSystemConfig: desktopBridgeUrl defaults to loopback + desktopBridgePort when unset', () => {
  const prevUrl = process.env.SIRA_DESKTOP_BRIDGE_URL;
  const prevPort = process.env.SIRA_DESKTOP_BRIDGE_PORT;
  delete process.env.SIRA_DESKTOP_BRIDGE_URL;
  delete process.env.SIRA_DESKTOP_BRIDGE_PORT;
  try {
    const cfg = loadSystemConfig();
    assert.equal(cfg.desktopBridgePort, 4601);
    assert.equal(cfg.desktopBridgeUrl, 'http://127.0.0.1:4601');
  } finally {
    if (prevUrl !== undefined) process.env.SIRA_DESKTOP_BRIDGE_URL = prevUrl; else delete process.env.SIRA_DESKTOP_BRIDGE_URL;
    if (prevPort !== undefined) process.env.SIRA_DESKTOP_BRIDGE_PORT = prevPort; else delete process.env.SIRA_DESKTOP_BRIDGE_PORT;
  }
});

test('loadSystemConfig: SIRA_DESKTOP_BRIDGE_PORT changes the derived default URL; SIRA_DESKTOP_BRIDGE_URL overrides it outright', () => {
  const prevUrl = process.env.SIRA_DESKTOP_BRIDGE_URL;
  const prevPort = process.env.SIRA_DESKTOP_BRIDGE_PORT;
  try {
    delete process.env.SIRA_DESKTOP_BRIDGE_URL;
    process.env.SIRA_DESKTOP_BRIDGE_PORT = '5555';
    assert.equal(loadSystemConfig().desktopBridgeUrl, 'http://127.0.0.1:5555');

    process.env.SIRA_DESKTOP_BRIDGE_URL = 'http://127.0.0.1:9999';
    assert.equal(loadSystemConfig().desktopBridgeUrl, 'http://127.0.0.1:9999');
  } finally {
    if (prevUrl !== undefined) process.env.SIRA_DESKTOP_BRIDGE_URL = prevUrl; else delete process.env.SIRA_DESKTOP_BRIDGE_URL;
    if (prevPort !== undefined) process.env.SIRA_DESKTOP_BRIDGE_PORT = prevPort; else delete process.env.SIRA_DESKTOP_BRIDGE_PORT;
  }
});
