// Static file serving for web/ with SPA fallback to index.html.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

export function serveStatic(webDir: string, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const resolved = normalize(join(webDir, pathname));
  if (!resolved.startsWith(webDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  let filePath = resolved;
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // SPA fallback: any non-file, non-API path serves the app shell.
    filePath = join(webDir, 'index.html');
    if (!existsSync(filePath)) {
      res.writeHead(404).end('not found');
      return;
    }
  }

  // no-cache = always revalidate with the server (304 when unchanged via
  // Last-Modified). A local-machine app must NEVER serve stale interface
  // code from the browser HTTP cache — that is how "the update didn't
  // appear" (and long-fixed bugs haunting the owner) happens.
  const stat = statSync(filePath);
  const lastModified = stat.mtime.toUTCString();
  if (req.headers['if-modified-since'] === lastModified) {
    res.writeHead(304, { 'last-modified': lastModified, 'cache-control': 'no-cache' }).end();
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(filePath)] ?? 'application/octet-stream',
    'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'no-cache',
    'last-modified': lastModified,
  });
  createReadStream(filePath).pipe(res);
}
