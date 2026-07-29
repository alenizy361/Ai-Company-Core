// Idempotent seeding of the org + agent roster from config/agents.json.
// Called on server and worker boot, and by `npm run seed`.
// Agents are created with lifecycle 'not_configured'; they become 'active'
// only when a prompt version is promoted through the eval harness.
import type { Db } from './db.ts';
import { ulid } from './ids.ts';
import { loadAgentsConfig, loadSystemConfig } from './config.ts';

export function seedOrgAndAgents(db: Db): void {
  const cfg = loadSystemConfig();
  const now = Date.now();
  db.transaction(() => {
    const org = db.get('SELECT id FROM orgs WHERE id = ?', cfg.orgId);
    if (!org) {
      db.run('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)', cfg.orgId, 'SIRA', now);
    } else {
      // One-time rebrand of DBs seeded under the previous product name.
      db.run(`UPDATE orgs SET name = 'SIRA' WHERE id = ? AND name = 'Rabit AI Company'`, cfg.orgId);
    }
    for (const agent of loadAgentsConfig()) {
      const existing = db.get<{ id: string }>('SELECT id FROM agents WHERE key = ?', agent.key);
      if (existing) {
        db.run(
          `UPDATE agents SET short = ?, name_en = ?, name_ar = ?, color = ?, reports_to = ?, updated_at = ?
           WHERE key = ?`,
          agent.short, agent.nameEn, agent.nameAr, agent.color, agent.reportsTo, now, agent.key,
        );
      } else {
        db.run(
          `INSERT INTO agents (id, org_id, key, short, name_en, name_ar, color, reports_to, lifecycle, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'not_configured', ?, ?)`,
          ulid('agt'), cfg.orgId, agent.key, agent.short, agent.nameEn, agent.nameAr, agent.color, agent.reportsTo, now, now,
        );
      }
    }
  });
}
