import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globMatch, pathAllowed, resolveWorkspacePath, commandAllowed, approvalRequired } from '../../src/tools/policy.ts';
import type { RolePolicy } from '../../src/shared/config.ts';

const policy: RolePolicy = {
  tools: ['write_file', 'run_command'],
  paths: { read: ['**'], write: ['web/**', 'docs/*'] },
  commands: [{ bin: 'node' }, { bin: 'npm', argsPrefix: ['run'] }],
  approvalRequired: [{ tool: 'run_command', match: 'npm install*' }],
};

test('glob semantics', () => {
  assert.ok(globMatch('web/**', 'web/js/deep/file.js'));
  assert.ok(!globMatch('web/**', 'src/file.ts'));
  assert.ok(globMatch('docs/*', 'docs/a.md'));
  assert.ok(!globMatch('docs/*', 'docs/sub/a.md'));
});

test('pathAllowed by effect', () => {
  assert.ok(pathAllowed(policy, 'web/app.js', 'write'));
  assert.ok(!pathAllowed(policy, 'src/index.ts', 'write'));
  assert.ok(pathAllowed(policy, 'src/index.ts', 'read'));
});

test('containment rejects traversal and absolute paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'rabit-policy-'));
  assert.throws(() => resolveWorkspacePath(root, '../outside.txt'));
  assert.throws(() => resolveWorkspacePath(root, '/etc/passwd'));
  assert.throws(() => resolveWorkspacePath(root, 'a/../../escape'));
  const ok = resolveWorkspacePath(root, 'web/app.js');
  assert.equal(ok.rel, 'web/app.js');
  rmSync(root, { recursive: true, force: true });
});

test('containment rejects symlink escape', () => {
  const root = mkdtempSync(join(tmpdir(), 'rabit-symlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'rabit-outside-'));
  mkdirSync(join(root, 'web'), { recursive: true });
  symlinkSync(outside, join(root, 'web', 'link'));
  assert.throws(() => resolveWorkspacePath(root, 'web/link/steal.txt'));
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('command allowlist: bin + argument prefix, no shell tricks', () => {
  assert.ok(commandAllowed(policy, 'node script.js'));
  assert.ok(commandAllowed(policy, 'npm run build'));
  assert.ok(!commandAllowed(policy, 'npm install evil'));
  assert.ok(!commandAllowed(policy, 'bash -c "rm -rf /"'));
  assert.ok(!commandAllowed(policy, 'rm -rf /'));
});

test('approval matchers', () => {
  assert.ok(approvalRequired(policy, 'run_command', { cmd: 'npm install zod' }));
  assert.ok(!approvalRequired(policy, 'run_command', { cmd: 'npm run build' }));
  assert.ok(!approvalRequired(policy, 'write_file', { path: 'web/a.js' }));
});
