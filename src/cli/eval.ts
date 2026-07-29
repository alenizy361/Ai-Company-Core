// Eval CLI: run an agent's suite (all agents by default) and optionally
// promote passing candidates.  Usage:
//   npm run eval                    # all agents, report only
//   npm run eval -- ceo backend     # specific agents
//   npm run eval -- --promote       # promote versions that pass the gate
import { join } from 'node:path';
import { openDb } from '../shared/db.ts';
import { loadPaths, loadPermissions } from '../shared/config.ts';
import { seedOrgAndAgents } from '../shared/seed.ts';
import { seedPromptsFromDisk } from '../promptreg/registry.ts';
import { buildCasesForAgent } from '../evals/cases.ts';
import { runEvalSuite } from '../evals/runner.ts';
import { promoteIfPassing } from '../evals/promote.ts';

const args = process.argv.slice(2);
const promote = args.includes('--promote');
const requested = args.filter((a) => !a.startsWith('--'));

const paths = loadPaths();
const db = openDb(paths.dbPath, paths.migrationsDir);
seedOrgAndAgents(db);
seedPromptsFromDisk(db, paths.promptsDir);

const policies = loadPermissions();
// Spec activation order.
const ORDER = ['ceo', 'backend', 'qa', 'pm', 'frontend', 'database', 'operations', 'security', 'ux', 'analytics', 'marketing', 'finance', 'support'];
const agents = requested.length ? requested : ORDER;
const scratchRoot = join(paths.varDir, 'eval-runs');

let failures = 0;
for (const agentKey of agents) {
  const policy = policies[agentKey];
  if (!policy) {
    console.error(`[eval] unknown agent: ${agentKey}`);
    failures++;
    continue;
  }
  const cases = buildCasesForAgent(agentKey, policy);
  const summary = await runEvalSuite(db, agentKey, cases, scratchRoot, paths.promptsDir);
  const line = `[eval] ${agentKey}: ${summary.passed}/${summary.total} cases, score ${summary.score}%`;
  if (summary.score === 100) console.log(`${line} PASS`);
  else {
    failures++;
    console.error(`${line} FAIL`);
    for (const r of summary.results.filter((x) => !x.passed)) {
      console.error(`  ${r.caseId}:`);
      for (const d of r.details.filter((d) => !d.startsWith('PASS'))) console.error(`    ${d}`);
    }
  }
  if (promote) {
    const decision = promoteIfPassing(db, summary);
    console.log(`  promote: ${decision.promoted ? 'YES' : 'no'} (${decision.reason})${decision.agentActivated ? ' — AGENT ACTIVATED' : ''}`);
  }
}

db.close();
process.exit(failures ? 1 : 0);
