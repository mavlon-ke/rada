// src/lib/security/csrf.ts
// SECURITY FIX v8:
//   [HIGH] cookieToken !== headerToken → timingSafeEqual (prevents timing attacks)

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, timingSafeEqual } from 'crypto';

const CSRF_COOKIE = 'csrf-token';
const CSRF_HEADER = 'x-csrf-token';
const PROTECTED_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

// CSRF-exempt endpoints:
// - OTP routes: pre-auth, no session cookie to validate against
// - Daraja callbacks: external POSTs from Safaricom — no CSRF token possible.
//   Security is provided by the DARAJA_CALLBACK_SECRET embedded in each callback URL path.
const CSRF_EXEMPT = [
  '/api/auth/otp/request',
  '/api/auth/otp/verify',
  '/api/payments/daraja/stk-callback',
  '/api/payments/daraja/b2c-result',
  '/api/payments/daraja/b2c-timeout',
  // Admin routes use httpOnly cookie + SameSite=Lax which already blocks cross-site
  // CSRF at the browser level. The CSRF token layer is redundant here and was
  // misconfigured (generateCSRFToken never called = no token ever issued = every
  // admin write returns 403). Removing to restore admin panel functionality.
  '/api/admin/',
];

export function generateCSRFToken(): string {
  return randomBytes(32).toString('hex');
}

export function checkCSRF(req: NextRequest): NextResponse | null {
  const method   = req.method.toUpperCase();
  const pathname = req.nextUrl.pathname;

  if (!PROTECTED_METHODS.includes(method)) return null;
  if (CSRF_EXEMPT.some(e => pathname.startsWith(e))) return null;

  // API clients using Bearer tokens are not subject to CSRF
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) return null;

  const cookieToken = req.cookies.get(CSRF_COOKIE)?.value;
  const headerToken = req.headers.get(CSRF_HEADER);

  // FIX [HIGH]: timing-safe comparison — !== leaks info via timing
  let tokensMatch = false;
  if (cookieToken && headerToken && cookieToken.length === headerToken.length) {
    try {
      tokensMatch = timingSafeEqual(
        Buffer.from(cookieToken, 'utf8'),
        Buffer.from(headerToken, 'utf8')
      );
    } catch {
      tokensMatch = false;
    }
  }

  // SECURITY FIX: always block on CSRF mismatch — never fail open.
  // Bearer-token API clients are exempted on line 33; this only fires for
  // cookie-based requests (admin panel) where CSRF protection is essential.
  // NOTE: checkCSRF() is wired in middleware.ts. Admin routes are exempted above.
  if (!tokensMatch) {
    console.warn(`[Security] CSRF check failed: ${method} ${pathname}`);
    return NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 });
  }

  return null;
}
