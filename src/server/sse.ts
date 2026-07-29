// SSE hub. The execution_events table IS the bus between the worker process
// and connected clients: the hub polls for rows past its cursor and fans them
// out. Clients resume with Last-Event-ID (or ?since=N); a fresh client first
// loads GET /api/state (which includes lastSeq) and subscribes from there.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../shared/db.ts';

interface EventRow {
  seq: number;
  id: string;
  org_id: string;
  execution_id: string | null;
  task_id: string | null;
  agent_key: string | null;
  type: string;
  payload: string;
  created_at: number;
}

interface Client {
  res: ServerResponse;
  cursor: number;
}

const PING_MS = 15000;

export class SseHub {
  private db: Db;
  private clients = new Set<Client>();
  private cursor: number;
  private pollTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;

  constructor(db: Db, pollMs: number) {
    this.db = db;
    this.cursor = this.maxSeq();
    this.pollTimer = setInterval(() => this.poll(), pollMs);
    this.pingTimer = setInterval(() => this.ping(), PING_MS);
    this.pollTimer.unref();
    this.pingTimer.unref();
  }

  private maxSeq(): number {
    const row = this.db.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM execution_events');
    return row?.m ?? 0;
  }

  lastSeq(): number {
    return this.maxSeq();
  }

  clientCount(): number {
    return this.clients.size;
  }

  private rowsAfter(seq: number, limit = 500): EventRow[] {
    return this.db.all<EventRow>(
      'SELECT * FROM execution_events WHERE seq > ? ORDER BY seq LIMIT ?',
      seq,
      limit,
    );
  }

  private writeEvent(client: Client, row: EventRow): void {
    const data = JSON.stringify({
      seq: row.seq,
      type: row.type,
      executionId: row.execution_id,
      taskId: row.task_id,
      agentKey: row.agent_key,
      payload: JSON.parse(row.payload || '{}'),
      at: row.created_at,
    });
    client.res.write(`id: ${row.seq}\nevent: ${row.type}\ndata: ${data}\n\n`);
    client.cursor = row.seq;
  }

  private poll(): void {
    if (this.clients.size === 0) {
      // keep cursor advancing cheaply so a new client's replay stays bounded
      this.cursor = this.maxSeq();
      return;
    }
    const rows = this.rowsAfter(this.cursor);
    if (rows.length === 0) return;
    this.cursor = rows[rows.length - 1].seq;
    for (const client of this.clients) {
      try {
        for (const row of rows) {
          if (row.seq > client.cursor) this.writeEvent(client, row);
        }
      } catch {
        this.drop(client);
      }
    }
  }

  private ping(): void {
    for (const client of this.clients) {
      try {
        client.res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        this.drop(client);
      }
    }
  }

  private drop(client: Client): void {
    this.clients.delete(client);
    try {
      client.res.end();
    } catch {
      /* already gone */
    }
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const lastEventId = req.headers['last-event-id'];
    const since = Number(
      (Array.isArray(lastEventId) ? lastEventId[0] : lastEventId) ?? url.searchParams.get('since') ?? this.cursor,
    );

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`: connected ${Date.now()}\n\n`);

    const client: Client = { res, cursor: Number.isFinite(since) ? since : this.cursor };

    // Replay everything the client missed, in pages, before joining the live set.
    let replaying = true;
    while (replaying) {
      const rows = this.rowsAfter(client.cursor);
      if (rows.length === 0) replaying = false;
      for (const row of rows) this.writeEvent(client, row);
    }
    if (client.cursor > this.cursor) this.cursor = client.cursor;

    this.clients.add(client);
    req.on('close', () => this.drop(client));
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const client of this.clients) this.drop(client);
  }
}
