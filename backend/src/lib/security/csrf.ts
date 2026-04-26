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
// - Paystack webhook: external POST signed with Paystack secret, no CSRF token possible
const CSRF_EXEMPT = [
  '/api/auth/otp/request',
  '/api/auth/otp/verify',
  '/api/payments/paystack/webhook',
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
  // NOTE: as of this commit, checkCSRF() is not yet wired into the request pipeline.
  // See follow-up: issue csrf-token cookie on admin login and add x-csrf-token header in adminFetch.
  if (!tokensMatch) {
    console.warn(`[Security] CSRF check failed: ${method} ${pathname}`);
    return NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 });
  }

  return null;
}
