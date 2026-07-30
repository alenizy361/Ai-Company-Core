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
  const root = mkdtempSync(join(tmpdir(), 'sira-policy-'));
  assert.throws(() => resolveWorkspacePath(root, '../outside.txt'));
  assert.throws(() => resolveWorkspacePath(root, '/etc/passwd'));
  assert.throws(() => resolveWorkspacePath(root, 'a/../../escape'));
  const ok = resolveWorkspacePath(root, 'web/app.js');
  assert.equal(ok.rel, 'web/app.js');
  rmSync(root, { recursive: true, force: true });
});

test('containment rejects symlink escape', () => {
  const root = mkdtempSync(join(tmpdir(), 'sira-symlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'sira-outside-'));
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

// Phase 2 security: interpreter -e/-c flags turn an otherwise-allowlisted
// bare binary into unrestricted code execution — this must be denied
// UNCONDITIONALLY, before the allowlist, regardless of any role's
// argsPrefix. Covers every interpreter this project ever allowlists
// (`{bin:"node"}` with no argsPrefix is the exact vulnerable shape).
const interpreterPolicy: RolePolicy = {
  tools: ['run_command'],
  paths: { read: ['**'], write: [] },
  commands: [
    { bin: 'node' }, { bin: 'nodejs' }, { bin: 'python' }, { bin: 'python3' },
    { bin: 'perl' }, { bin: 'ruby' }, { bin: 'bash' }, { bin: 'sh' }, { bin: 'zsh' }, { bin: 'dash' },
  ],
  approvalRequired: [],
};

test('interpreter eval flags are denied unconditionally, even for an allowlisted bare binary', () => {
  assert.ok(!commandAllowed(interpreterPolicy, 'node -e "require(\'child_process\').execSync(\'id\')"'));
  assert.ok(!commandAllowed(interpreterPolicy, 'node --eval console.log(1)'));
  assert.ok(!commandAllowed(interpreterPolicy, 'node -p 1+1'));
  assert.ok(!commandAllowed(interpreterPolicy, 'node --print 1+1'));
  assert.ok(!commandAllowed(interpreterPolicy, 'nodejs -e "process.exit(1)"'));
  assert.ok(!commandAllowed(interpreterPolicy, 'python -c "import os; os.system(\'id\')"'));
  assert.ok(!commandAllowed(interpreterPolicy, 'python3 -c "import os; os.system(\'id\')"'));
  assert.ok(!commandAllowed(interpreterPolicy, 'perl -e "system(\'id\')"'));
  assert.ok(!commandAllowed(interpreterPolicy, 'ruby -e "system(\'id\')"'));
  assert.ok(!commandAllowed(interpreterPolicy, 'bash -c "id"'));
  assert.ok(!commandAllowed(interpreterPolicy, 'sh -c "id"'));
  assert.ok(!commandAllowed(interpreterPolicy, 'zsh -c "id"'));
  assert.ok(!commandAllowed(interpreterPolicy, 'dash -c "id"'));
});

test('interpreter eval denial cannot be dodged by obfuscating the payload — the flag literal alone triggers it', () => {
  // A base64-encoded, whitespace-free payload decoded and executed at
  // runtime: the flag token itself ("-e") is still argv[1] regardless of
  // what the payload contains or how it's encoded, so the unconditional
  // check still catches it before the allowlist is ever consulted.
  const b64 = 'Y29uc29sZS5sb2cocHJvY2Vzcy5lbnYpOw==';
  assert.ok(!commandAllowed(interpreterPolicy, `node -e eval(Buffer.from('${b64}','base64').toString())`));
  assert.ok(!commandAllowed(interpreterPolicy, `python3 -c exec(__import__('base64').b64decode('${b64}'))`));
});

test('interpreter eval guard does not block legitimate script invocation', () => {
  assert.ok(commandAllowed(interpreterPolicy, 'node script.js'));
  assert.ok(commandAllowed(interpreterPolicy, 'python3 script.py'));
  assert.ok(commandAllowed(interpreterPolicy, 'bash deploy.sh'));
  // A flag-like value that happens to appear as an ARGUMENT to the script
  // (not to the interpreter itself) is unaffected — only argv[1] itself is
  // checked against the interpreter's own eval-flag pattern.
  assert.ok(commandAllowed(interpreterPolicy, 'node script.js --extra'));
});

test('interpreter eval guard applies per-interpreter — a flag meaningless to one interpreter is not misapplied to another', () => {
  // node's -p (print) is not a bash flag; bash's -c is not a node flag.
  // The map is keyed per bin, so this cannot cross-contaminate.
  assert.ok(!commandAllowed(interpreterPolicy, 'node -p 1'));
  assert.ok(commandAllowed(interpreterPolicy, 'bash -p'), 'bash has no -p eval flag in the map — not a code-exec vector');
});
