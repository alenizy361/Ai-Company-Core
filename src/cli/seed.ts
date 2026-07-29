// Seed the database: org + agents from config, prompt versions from prompts/.
import { openDb } from '../shared/db.ts';
import { loadPaths } from '../shared/config.ts';
import { seedOrgAndAgents } from '../shared/seed.ts';
import { seedPromptsFromDisk } from '../promptreg/registry.ts';

const paths = loadPaths();
const db = openDb(paths.dbPath, paths.migrationsDir);
seedOrgAndAgents(db);
const results = seedPromptsFromDisk(db, paths.promptsDir);
const changed = results.filter((r) => r.action !== 'unchanged');
console.log(`[seed] prompts: ${results.length} files, ${changed.length} new versions`);
for (const r of changed) console.log(`  ${r.action}: ${r.scope}/${r.key} v${r.version}`);
db.close();
