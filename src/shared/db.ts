// Thin wrapper over node:sqlite with a better-sqlite3-shaped surface, so the
// engine can be swapped by changing only this file. Opens in WAL mode; both the
// API server and the worker share one database file safely.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Row = Record<string, unknown>;
export type SqlValue = string | number | bigint | null;

const BUSY_RETRIES = 5;
const BUSY_BACKOFF_MS = 50;

function isBusy(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('SQLITE_BUSY') || msg.includes('database is locked');
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class Db {
  readonly path: string;
  private sqlite: DatabaseSync;
  private stmts = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec('PRAGMA journal_mode = WAL');
    this.sqlite.exec('PRAGMA busy_timeout = 5000');
    this.sqlite.exec('PRAGMA synchronous = NORMAL');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.sqlite.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private withBusyRetry<T>(fn: () => T): T {
    // Inside an explicit transaction we must not retry silently: the caller's
    // transaction wrapper owns retry semantics for the whole unit.
    if (this.txDepth > 0) return fn();
    for (let attempt = 0; ; attempt++) {
      try {
        return fn();
      } catch (err) {
        if (!isBusy(err) || attempt >= BUSY_RETRIES) throw err;
        sleepSync(BUSY_BACKOFF_MS * (attempt + 1));
      }
    }
  }

  run(sql: string, ...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.withBusyRetry(() => this.stmt(sql).run(...params));
  }

  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.withBusyRetry(() => this.stmt(sql).get(...params)) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.withBusyRetry(() => this.stmt(sql).all(...params)) as T[];
  }

  exec(sql: string): void {
    this.withBusyRetry(() => this.sqlite.exec(sql));
  }

  /** Runs fn inside BEGIN IMMEDIATE .. COMMIT with busy retry of the whole unit. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn(); // nested: join the outer transaction
    for (let attempt = 0; ; attempt++) {
      try {
        this.sqlite.exec('BEGIN IMMEDIATE');
      } catch (err) {
        if (isBusy(err) && attempt < BUSY_RETRIES) {
          sleepSync(BUSY_BACKOFF_MS * (attempt + 1));
          continue;
        }
        throw err;
      }
      this.txDepth++;
      try {
        const result = fn();
        this.txDepth--;
        this.sqlite.exec('COMMIT');
        return result;
      } catch (err) {
        this.txDepth--;
        try {
          this.sqlite.exec('ROLLBACK');
        } catch {
          /* connection-level failure; original error matters more */
        }
        if (isBusy(err) && attempt < BUSY_RETRIES) {
          sleepSync(BUSY_BACKOFF_MS * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  }

  migrate(migrationsDir: string): void {
    this.exec(`CREATE TABLE IF NOT EXISTS migrations (
      version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT`);
    const applied = new Set(this.all<{ version: string }>('SELECT version FROM migrations').map((r) => r.version));
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(`${migrationsDir}/${file}`, 'utf8');
      this.transaction(() => {
        this.sqlite.exec(sql);
        this.stmt('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(file, Date.now());
      });
    }
  }

  close(): void {
    this.stmts.clear();
    this.sqlite.close();
  }
}

export function openDb(path: string, migrationsDir?: string): Db {
  const db = new Db(path);
  if (migrationsDir) db.migrate(migrationsDir);
  return db;
}
