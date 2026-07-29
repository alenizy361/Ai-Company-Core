// Minimal HTTP router for node:http. Patterns like "/api/tasks/:id".
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RouteCtx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export type Handler = (ctx: RouteCtx) => void | Promise<void>;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

const MAX_BODY = 1_000_000;

export function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function errorJson(res: ServerResponse, status: number, code: string, message: string, extra?: Record<string, unknown>): void {
  json(res, status, { error: { code, message, ...extra } });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return undefined;
  return JSON.parse(text);
}

export class Router {
  private routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.on('GET', pattern, handler);
  }
  post(pattern: string, handler: Handler): this {
    return this.on('POST', pattern, handler);
  }
  delete(pattern: string, handler: Handler): this {
    return this.on('DELETE', pattern, handler);
  }

  /** Returns true if a route matched and was dispatched. */
  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathParts = url.pathname.split('/').filter(Boolean);

    for (const route of this.routes) {
      if (route.method !== req.method || route.parts.length !== pathParts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.parts.length; i++) {
        const rp = route.parts[i];
        if (rp.startsWith(':')) params[rp.slice(1)] = decodeURIComponent(pathParts[i]);
        else if (rp !== pathParts[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      let body: unknown;
      try {
        body = await readBody(req);
      } catch (err) {
        errorJson(res, 400, 'BAD_BODY', err instanceof Error ? err.message : 'invalid body');
        return true;
      }
      try {
        await route.handler({ req, res, params, query: url.searchParams, body });
      } catch (err) {
        if (!res.headersSent) {
          errorJson(res, 500, 'INTERNAL', err instanceof Error ? err.message : 'internal error');
        } else {
          res.end();
        }
      }
      return true;
    }
    return false;
  }
}
