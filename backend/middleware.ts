// middleware.ts — Global Next.js middleware v8
// Rate limiting is now async (Redis-backed) — uses await

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, handlePreflight, applyAllSecurity } from '@/lib/security/middleware';
import { checkCSRF } from '@/lib/security/csrf';

export async function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname;

  if (!pathname.startsWith('/api/')) return NextResponse.next();

  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  // Rate limiting is now async (Redis)
  const rateLimitResponse = await checkRateLimit(req);
  if (rateLimitResponse) return rateLimitResponse;

  const csrfResponse = checkCSRF(req);
  if (csrfResponse) return csrfResponse;

  const response = NextResponse.next();
  return applyAllSecurity(req, response);
}

export const config = { matcher: '/api/:path*' };
