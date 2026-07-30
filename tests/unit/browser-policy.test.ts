import { test } from 'node:test';
import assert from 'node:assert';
import { loadBrowserPolicy, isNavigationDenied, type BrowserPolicy } from '../../src/desktop-bridge/browser/policy.ts';

test('loadBrowserPolicy: reads config/browser-bridge.json, disabled by default', () => {
  const policy = loadBrowserPolicy();
  assert.equal(policy.enabled, false, 'the feature must be an explicit opt-in, never silently on');
  assert.ok(policy.deniedUrlPatterns.length > 0);
  assert.ok(policy.deniedUrlPatterns.every((p) => p instanceof RegExp));
});

test('isNavigationDenied: allows an ordinary https URL', () => {
  const policy: BrowserPolicy = { enabled: false, deniedUrlPatterns: [/^file:\/\//i, /^chrome:\/\//i, /^javascript:/i] };
  const result = isNavigationDenied(policy, 'https://example.com');
  assert.equal(result.denied, false);
});

test('isNavigationDenied: denies file://, chrome://, and javascript: URLs', () => {
  const policy: BrowserPolicy = { enabled: false, deniedUrlPatterns: [/^file:\/\//i, /^chrome:\/\//i, /^javascript:/i] };
  const denied = ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)'];
  for (const url of denied) {
    const result = isNavigationDenied(policy, url);
    assert.ok(result.denied, `expected "${url}" to be denied`);
    assert.match(result.reason ?? '', /denied pattern/);
  }
});
