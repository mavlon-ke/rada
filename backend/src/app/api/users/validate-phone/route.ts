// src/app/api/users/validate-phone/route.ts
// Check if a phone number belongs to a registered CheckRada user.
// Used by the multi-row challenge form to validate friend phone numbers.
// No auth required — phone is validated not revealed (name returned only if found).

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma }      from '@/lib/db/prisma';
import { displayName } from '@/lib/user/display-name';
import { withErrorHandling } from '@/lib/security/route-guard';

function normalisePhone(phone: string): string {
  return phone.replace(/\D/g, '').replace(/^0/, '254');
}

const Schema = z.object({
  phone: z.string().min(9).max(15),
});

export const POST = withErrorHandling(async function POST(req: NextRequest) {
  const body   = await req.json().catch(() => ({}));
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ valid: false, reason: 'Invalid phone format' });
  }

  const normed = normalisePhone(parsed.data.phone);
  const user   = await prisma.user.findUnique({
    where:  { phone: normed },
    select: { id: true, name: true, phone: true },
  });

  if (!user) {
    return NextResponse.json({ valid: false });
  }

  return NextResponse.json({
    valid: true,
    name:  displayName(user.name, user.phone),
  });
});
