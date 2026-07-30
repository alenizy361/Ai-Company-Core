// Owner runtime settings (server-side key/value; shared by API + worker).
import type { Db } from './db.ts';

export function getSetting(db: Db, key: string): string | null {
  return db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key, value, Date.now(),
  );
}
