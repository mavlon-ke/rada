// src/app/api/auth/check/route.ts
// SECURITY FIX: this endpoint previously leaked whether a phone was registered
// AND the registered user's first name, enabling user enumeration and targeted
// phishing. It now always returns a constant response regardless of input.
//
// Kept (rather than deleted) for backward-compatibility with browser-cached
// frontend builds that still call it. The frontend has been updated to skip
// this call entirely; this endpoint may be deleted in a future cleanup pass.

import { NextRequest, NextResponse } from 'next/server';

export function GET(_req: NextRequest) {
  return NextResponse.json({
    exists:    false,
    firstName: null,
  });
}
