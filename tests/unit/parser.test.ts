import { test } from 'node:test';
import assert from 'node:assert';
import { parsePlanResponse, type PlanContext } from '../../src/planning/plan-parser.ts';
import { loadPermissions } from '../../src/shared/config.ts';

const ctx: PlanContext = {
  agents: new Map([
    ['pm', 'active'], ['backend', 'active'], ['qa', 'active'], ['finance', 'not_configured'],
  ]),
  policies: loadPermissions(),
  maxSteps: 30,
  minSpecChars: 80,
};

const SPEC = 'A complete executable specification with plenty of concrete detail about exactly what to do and how done is defined.';
const step = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  step_id: 'step-one', agent: 'pm', title: 'Do the thing', spec: SPEC,
  depends_on: [], required_inputs: [], expected_artifacts: ['out.md'],
  acceptance_criteria: ['out.md exists'], verification: [{ type: 'artifact_exists', artifact: 'out.md' }],
  priority: 1, status: 'queued', ...over,
});
const wrap = (steps: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ reply: 'ok', team: ['pm'], plan: steps, ...extra });

function codesOf(text: string): string[] {
  const res = parsePlanResponse(text, ctx);
  return res.ok ? [] : res.errors.map((e) => e.code);
}

test('valid plan parses', () => {
  const res = parsePlanResponse(wrap([step()]), ctx);
  assert.ok(res.ok);
  assert.equal(res.ok && res.plan.plan[0].step_id, 'step-one');
});

test('reply-only plan (empty) is valid', () => {
  assert.ok(parsePlanResponse(wrap([]), ctx).ok);
});

test('NOT_SINGLE_JSON', () => assert.ok(codesOf('no json here at all').includes('NOT_SINGLE_JSON')));
test('UNKNOWN_AGENT', () => assert.ok(codesOf(wrap([step({ agent: 'wizard' })])).includes('UNKNOWN_AGENT')));
test('AGENT_NOT_ACTIVE', () => assert.ok(codesOf(wrap([step({ agent: 'finance' })])).includes('AGENT_NOT_ACTIVE')));
test('INVALID_STEP_ID', () => assert.ok(codesOf(wrap([step({ step_id: 'Bad Step!' })])).includes('INVALID_STEP_ID')));
test('DUPLICATE_STEP_ID', () =>
  assert.ok(codesOf(wrap([step(), step()])).includes('DUPLICATE_STEP_ID')));
test('UNKNOWN_DEPENDENCY', () =>
  assert.ok(codesOf(wrap([step({ depends_on: ['ghost'] })])).includes('UNKNOWN_DEPENDENCY')));
test('SELF_DEPENDENCY', () =>
  assert.ok(codesOf(wrap([step({ depends_on: ['step-one'] })])).includes('SELF_DEPENDENCY')));
test('CYCLE', () => {
  const a = step({ step_id: 'a', depends_on: ['b'] });
  const b = step({ step_id: 'b', depends_on: ['a'] });
  assert.ok(codesOf(wrap([a, b])).includes('CYCLE'));
});
test('VAGUE_SPEC', () => assert.ok(codesOf(wrap([step({ spec: 'improve UX' })])).includes('VAGUE_SPEC')));
test('MISSING_ACCEPTANCE', () =>
  assert.ok(codesOf(wrap([step({ acceptance_criteria: [] })])).includes('MISSING_ACCEPTANCE')));
test('MISSING_ARTIFACTS', () =>
  assert.ok(codesOf(wrap([step({ expected_artifacts: [] })])).includes('MISSING_ARTIFACTS')));
test('UNKNOWN_VERIFICATION_TYPE', () =>
  assert.ok(codesOf(wrap([step({ verification: [{ type: 'vibes' }] })])).includes('UNKNOWN_VERIFICATION_TYPE')));
test('PERMISSION_IMPOSSIBLE: verification command outside role allowlist', () => {
  // pm has no commands at all.
  const bad = step({ verification: [{ type: 'command', cmd: 'npm test' }] });
  assert.ok(codesOf(wrap([bad])).includes('PERMISSION_IMPOSSIBLE'));
});
test('command within role allowlist accepted', () => {
  const good = step({ agent: 'qa', verification: [{ type: 'command', cmd: 'npm test' }] });
  assert.ok(parsePlanResponse(wrap([good]), ctx).ok);
});
test('INVALID_STATUS', () => assert.ok(codesOf(wrap([step({ status: 'running' })])).includes('INVALID_STATUS')));
test('INVALID_PRIORITY', () => assert.ok(codesOf(wrap([step({ priority: 99 })])).includes('INVALID_PRIORITY')));
test('TOO_MANY_STEPS', () => {
  const steps = Array.from({ length: 31 }, (_, i) => step({ step_id: `s-${i}` }));
  assert.ok(codesOf(wrap(steps)).includes('TOO_MANY_STEPS'));
});
