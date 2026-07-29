// Backend verification of a completion claim. The model saying "complete"
// starts verification; only passing checks makes the task completed.
import { existsSync, readFileSync } from 'node:fs';
import type { Db } from '../shared/db.ts';
import { validate, type SchemaNode } from '../shared/jsonschema.ts';
import type { VerificationCheck } from '../planning/plan-parser.ts';
import type { RolePolicy } from '../shared/config.ts';
import { commandAllowed } from '../tools/policy.ts';
import { spawnSync } from 'node:child_process';

export interface CheckResult {
  check: string;
  ok: boolean;
  detail: string;
}

export interface VerifyInput {
  taskId: string;
  objectiveId: string;
  expectedArtifacts: string[];
  claimedArtifacts: string[];
  checks: VerificationCheck[];
  workspaceRoot: string;
  policy: RolePolicy;
  commandTimeoutMs: number;
}

function findArtifact(db: Db, taskId: string, name: string): { path: string } | undefined {
  return db.get<{ path: string }>(
    'SELECT path FROM artifacts WHERE task_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1', taskId, name,
  );
}

/**
 * Minimum substance for an expected deliverable. Existence alone let a
 * 1-character placeholder complete a task; this is a floor, not a quality
 * bar — plan verification checks and acceptance criteria do the rest.
 */
const MIN_ARTIFACT_CHARS = 20;

export function verifyCompletion(db: Db, input: VerifyInput): { passed: boolean; results: CheckResult[] } {
  const results: CheckResult[] = [];

  for (const name of input.expectedArtifacts) {
    const artifact = findArtifact(db, input.taskId, name);
    if (!artifact) {
      results.push({ check: `expected_artifact:${name}`, ok: false, detail: 'no artifact with this name was created by this task' });
    } else if (!existsSync(artifact.path)) {
      results.push({ check: `expected_artifact:${name}`, ok: false, detail: 'artifact row exists but bytes are missing' });
    } else {
      const content = readFileSync(artifact.path, 'utf8');
      if (content.trim().length < MIN_ARTIFACT_CHARS) {
        results.push({
          check: `expected_artifact:${name}`, ok: false,
          detail: `artifact exists but holds only ${content.trim().length} chars — a placeholder is not a deliverable`,
        });
      } else {
        results.push({ check: `expected_artifact:${name}`, ok: true, detail: 'exists with substantive content' });
      }
    }
  }

  // The completion claim must own its deliverables: every expected artifact
  // has to be listed in the claim's artifacts array. An agent that cannot
  // even name what it produced has not verified its own work.
  if (input.expectedArtifacts.length > 0) {
    const missing = input.expectedArtifacts.filter((name) => !input.claimedArtifacts.includes(name));
    if (missing.length > 0) {
      results.push({
        check: 'claimed_artifacts', ok: false,
        detail: `the completion claim must list every expected artifact in "artifacts"; missing: ${missing.join(', ')}`,
      });
    }
  }

  for (const check of input.checks) {
    if (check.type === 'artifact_exists') {
      const artifact = check.artifact ? findArtifact(db, input.taskId, check.artifact) : undefined;
      results.push({
        check: `artifact_exists:${check.artifact}`,
        ok: !!artifact && existsSync(artifact.path),
        detail: artifact ? 'found' : 'not found for this task',
      });
    } else if (check.type === 'contains') {
      const needle = (check.needle ?? '').trim();
      if (!needle) {
        // content.includes('') is always true — an empty needle is a check
        // that verifies nothing while looking green. Refuse the vacuous pass.
        results.push({ check: `contains:${check.artifact}`, ok: false, detail: 'contains check has an empty needle — it can never verify anything' });
        continue;
      }
      const artifact = check.artifact ? findArtifact(db, input.taskId, check.artifact) : undefined;
      if (!artifact || !existsSync(artifact.path)) {
        results.push({ check: `contains:${check.artifact}`, ok: false, detail: 'artifact missing' });
      } else {
        const content = readFileSync(artifact.path, 'utf8');
        const found = content.includes(check.needle ?? '');
        results.push({
          check: `contains:${check.artifact}`,
          ok: found,
          detail: found ? `contains "${check.needle}"` : `does not contain "${check.needle}"`,
        });
      }
    } else if (check.type === 'json_schema') {
      const schemaObj = check.schema;
      if (!schemaObj || typeof schemaObj !== 'object' || Array.isArray(schemaObj) || Object.keys(schemaObj).length === 0) {
        results.push({ check: `json_schema:${check.artifact}`, ok: false, detail: 'json_schema check has no schema — any JSON would pass; refusing the vacuous check' });
        continue;
      }
      const artifact = check.artifact ? findArtifact(db, input.taskId, check.artifact) : undefined;
      if (!artifact || !existsSync(artifact.path)) {
        results.push({ check: `json_schema:${check.artifact}`, ok: false, detail: 'artifact missing' });
      } else {
        try {
          const parsed = JSON.parse(readFileSync(artifact.path, 'utf8'));
          const errors = validate(schemaObj as SchemaNode, parsed);
          results.push({
            check: `json_schema:${check.artifact}`,
            ok: errors.length === 0,
            detail: errors.length ? errors.map((e) => `${e.path}: ${e.message}`).join('; ') : 'valid',
          });
        } catch (err) {
          results.push({ check: `json_schema:${check.artifact}`, ok: false, detail: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    } else if (check.type === 'command') {
      const cmd = check.cmd ?? '';
      if (!commandAllowed(input.policy, cmd)) {
        results.push({ check: `command:${cmd}`, ok: false, detail: 'verification command outside agent command policy' });
        continue;
      }
      const parts = cmd.trim().split(/\s+/);
      const res = spawnSync(parts[0], parts.slice(1), {
        cwd: input.workspaceRoot,
        timeout: input.commandTimeoutMs,
        encoding: 'utf8',
        shell: false,
        env: { PATH: process.env.PATH ?? '', HOME: input.workspaceRoot },
      });
      const exit = res.status ?? -1;
      const expected = check.expect_exit ?? 0;
      results.push({
        check: `command:${cmd}`,
        ok: exit === expected,
        detail: `exit ${exit} (expected ${expected}); stderr: ${(res.stderr ?? '').slice(0, 500)}`,
      });
    }
  }

  return { passed: results.every((r) => r.ok), results };
}
