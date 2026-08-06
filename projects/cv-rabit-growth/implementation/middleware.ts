// Root redirect fix — replaces the current cookie-based 307 with a stable 301.
//
// WHERE IT GOES: /middleware.ts at the repo root of the cv.rabit.sa Next.js app
// (merge with existing middleware if one exists).
//
// Why: the audit found `/` issues a 307 that varies by cookie. Search engines
// treat 307 as temporary and cookie-dependent responses as unstable, so the
// root's link equity never consolidates onto /ar. Also /en currently 404s.

import { NextRequest, NextResponse } from 'next/server';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Root → permanent redirect to Arabic (primary audience).
  // No cookie logic here: crawlers must always see the same 301.
  // Returning users who prefer EN use the visible language switcher instead.
  if (pathname === '/') {
    return NextResponse.redirect(new URL('/ar', req.url), 301);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/'],
};

// ALSO REQUIRED (separate fix): /en must resolve, not 404.
// Either render the English homepage at /en, or 301 /en → /en/home —
// whatever matches the routing structure. A 404 on a language root
// invalidates every hreflang tag that points at /en/*.
//
// VERIFICATION after deploy:
//   curl -sI https://cv.rabit.sa/        → HTTP/2 301, location: /ar (no Set-Cookie variance)
//   curl -sI https://cv.rabit.sa/en      → HTTP/2 200 (or a single 301 to a 200)
