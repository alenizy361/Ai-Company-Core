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

export function verifyCompletion(db: Db, input: VerifyInput): { passed: boolean; results: CheckResult[] } {
  const results: CheckResult[] = [];

  for (const name of input.expectedArtifacts) {
    const artifact = findArtifact(db, input.taskId, name);
    if (!artifact) {
      results.push({ check: `expected_artifact:${name}`, ok: false, detail: 'no artifact with this name was created by this task' });
    } else if (!existsSync(artifact.path)) {
      results.push({ check: `expected_artifact:${name}`, ok: false, detail: 'artifact row exists but bytes are missing' });
    } else {
      results.push({ check: `expected_artifact:${name}`, ok: true, detail: 'exists with stored bytes' });
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
      const artifact = check.artifact ? findArtifact(db, input.taskId, check.artifact) : undefined;
      if (!artifact || !existsSync(artifact.path)) {
        results.push({ check: `json_schema:${check.artifact}`, ok: false, detail: 'artifact missing' });
      } else {
        try {
          const parsed = JSON.parse(readFileSync(artifact.path, 'utf8'));
          const errors = validate((check.schema ?? { type: 'object' }) as SchemaNode, parsed);
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
