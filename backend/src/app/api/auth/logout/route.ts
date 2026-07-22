// src/app/api/auth/logout/route.ts
// Clears the httpOnly session cookie on logout.
//
// Since the JWT lives only in a httpOnly cookie (not localStorage) after the
// 3.1 fix, frontend logOut() must call this endpoint to invalidate the session
// server-side. Without this, the cookie persists indefinitely after logout.
//
// The cookie is overwritten with an empty value and maxAge:0 — the browser
// deletes it immediately on response receipt.

import { NextRequest, NextResponse } from 'next/server';
import { withErrorHandling }         from '@/lib/security/route-guard';

export const POST = withErrorHandling(async (_req: NextRequest) => {
  const res = NextResponse.json({ success: true });
  res.cookies.set('token', '', {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   0,   // instruct browser to delete the cookie immediately
    path:     '/',
  });
  return res;
});
