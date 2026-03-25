// src/app/api/users/me/profile/route.ts
// PATCH /api/users/me/profile — Update name, agreedToTerms, confirmedAge
// Called by rada-auth.html after new user completes registration step

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { sanitizeText } from '@/lib/security/middleware';
import { withErrorHandling } from '@/lib/security/route-guard';

const ProfileSchema = z.object({
  name:          z.string().min(2).max(80).optional(),
  agreedToTerms: z.boolean().optional(),
  confirmedAge:  z.boolean().optional(),
});

export const PATCH = withErrorHandling(async (req: NextRequest) => {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json();
  const parsed = ProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data' }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name)          updates.name          = sanitizeText(parsed.data.name);
  if (parsed.data.agreedToTerms) updates.agreedToTerms = true; // can only set to true, never false
  if (parsed.data.confirmedAge)  updates.confirmedAge  = true;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ message: 'No changes' }, { status: 200 });
  }

  const updated = await prisma.user.update({
    where:  { id: user.id },
    data:   updates,
    select: { id: true, phone: true, name: true, agreedToTerms: true, confirmedAge: true, kycStatus: true, referralCode: true, balanceKes: true, bonusBalanceKes: true },
  });

  return NextResponse.json({ success: true, user: updated });
});
