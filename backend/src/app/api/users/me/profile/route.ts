// src/app/api/users/me/profile/route.ts
// PATCH /api/users/me/profile — Update name, agreedToTerms, confirmedAge
// Called by rada-auth.html after new user completes registration step (compliance only).
// Also called by rada-portfolio.html for voluntary name setting / clearing.
//
// Name clearing: sending name: "" (empty string) sets name to null.
// This returns the user to masked-phone display on leaderboard, challenges, etc.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { sanitizeText } from '@/lib/security/middleware';
import { withErrorHandling } from '@/lib/security/route-guard';

const ProfileSchema = z.object({
  name:          z.string().max(80).optional(),   // empty string allowed → clears name
  agreedToTerms: z.boolean().optional(),
  confirmedAge:  z.boolean().optional(),
});

export async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const fresh = await prisma.user.findUnique({
    where:  { id: user.id },
    select: {
      id: true, phone: true, name: true,
      balanceKes: true, bonusBalanceKes: true,
      kycStatus: true, referralCode: true,
      agreedToTerms: true, confirmedAge: true,
      createdAt: true,
    },
  });

  if (!fresh) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  return NextResponse.json({ user: fresh });
}

export const PATCH = withErrorHandling(async (req: NextRequest) => {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json();
  const parsed = ProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data' }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};

  // Name: undefined = not changing, "" = clear to null, any string = set
  if (parsed.data.name !== undefined) {
    const trimmed = parsed.data.name.trim();
    if (trimmed.length === 0) {
      updates.name = null;                         // clear — user returns to masked phone display
    } else if (trimmed.length < 2) {
      return NextResponse.json({ error: 'Name must be at least 2 characters' }, { status: 400 });
    } else {
      updates.name = sanitizeText(trimmed);
    }
  }
  if (parsed.data.agreedToTerms) updates.agreedToTerms = true;  // can only set to true, never false
  if (parsed.data.confirmedAge)  updates.confirmedAge  = true;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ message: 'No changes' }, { status: 200 });
  }

  const updated = await prisma.user.update({
    where:  { id: user.id },
    data:   updates,
    select: {
      id: true, phone: true, name: true,
      agreedToTerms: true, confirmedAge: true,
      kycStatus: true, referralCode: true,
      balanceKes: true, bonusBalanceKes: true,
    },
  });

  return NextResponse.json({ success: true, user: updated });
});
