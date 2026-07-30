import { test } from 'node:test';
import assert from 'node:assert';
import { loadDesktopPolicy, isCatastrophic, resolveCuratedApp } from '../../src/desktop-bridge/policy.ts';

test('loadDesktopPolicy: reads config/desktop-bridge.json, disabled by default', () => {
  const policy = loadDesktopPolicy();
  assert.equal(policy.enabled, false, 'the feature must be an explicit opt-in, never silently on');
  assert.ok(policy.deniedCommandPatterns.length > 0);
  assert.ok(policy.deniedCommandPatterns.every((p) => p instanceof RegExp));
  assert.ok(resolveCuratedApp(policy, 'browser'));
});

test('isCatastrophic: denies disk-wipe, root-deletion, and self-sabotage commands', () => {
  const policy = loadDesktopPolicy();
  const denied = [
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda',
    'shred -vfz -n 10 /dev/sda',
    'wipefs -a /dev/sda',
    'blkdiscard /dev/sda',
    'fdisk /dev/sda',
    'rm -rf /',
    'rm -rf /*',
    'rm -rf /etc',
    'sudo rm -rf /home',
    'shutdown -h now',
    'reboot',
    'poweroff',
    'systemctl stop sira-api',
    'systemctl disable sira-worker',
    'apt purge *',
    'chmod -R 777 /',
    'chown -R nobody /',
    ':(){ :|:& };:',
  ];
  for (const cmd of denied) {
    const result = isCatastrophic(policy, cmd);
    assert.ok(result.denied, `expected "${cmd}" to be denied`);
    assert.ok(result.reason, `expected a reason for "${cmd}"`);
  }
});

test('isCatastrophic: does not deny ordinary, legitimate commands', () => {
  const policy = loadDesktopPolicy();
  const allowed = [
    'firefox',
    'gio launch firefox.desktop',
    'gnome-terminal',
    'ls -la /home/owner/Documents',
    'rm myfile.txt',
    'systemctl status sira-api',
  ];
  for (const cmd of allowed) {
    const result = isCatastrophic(policy, cmd);
    assert.equal(result.denied, false, `expected "${cmd}" to be allowed, got denied: ${result.reason}`);
  }
});

test('isCatastrophic: denies commands referencing sensitive credential paths', () => {
  const policy = loadDesktopPolicy();
  const result = isCatastrophic(policy, 'cat /home/owner/.ssh/id_rsa');
  assert.ok(result.denied);
  assert.match(result.reason ?? '', /sensitive path/);
});

test('resolveCuratedApp: returns undefined for an unknown app name', () => {
  const policy = loadDesktopPolicy();
  assert.equal(resolveCuratedApp(policy, 'not-a-real-app'), undefined);
});
