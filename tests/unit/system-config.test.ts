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
