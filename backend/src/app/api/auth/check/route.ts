// src/app/api/auth/check/route.ts
// GET /api/auth/check?phone=254712345678
// Returns whether a phone number is already registered.
// Used by the frontend for smart login/signup detection.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

function normalisePhone(phone: string): string {
  return phone.replace(/\D/g, '').replace(/^0/, '254');
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get('phone') || '';

  if (!raw || raw.length < 9) {
    return NextResponse.json({ error: 'Phone number required' }, { status: 400 });
  }

  const phone = normalisePhone(raw);

  const user = await prisma.user.findUnique({
    where: { phone },
    select: { id: true, name: true }, // Only return name — no sensitive data
  });

  return NextResponse.json({
    exists: !!user,
    // Return first name only for the "Welcome back" greeting
    // Full identity confirmed only after OTP verification
    firstName: user?.name ? user.name.split(' ')[0] : null,
  });
}
