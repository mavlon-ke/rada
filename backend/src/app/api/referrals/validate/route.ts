// src/app/api/referrals/validate/route.ts
// Validates a referral code at signup time.
// Called by the auth page when user enters a referral code.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { z } from 'zod';

const Schema = z.object({ code: z.string().min(1).max(20) });

export async function POST(req: NextRequest) {
  const body   = await req.json();
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid code format' }, { status: 400 });
  }

  const code = parsed.data.code.toUpperCase().trim();

  // Check referral programme is active
  const config = await prisma.referralConfig.findUnique({ where: { id: 'singleton' } });
  if (!config?.active) {
    return NextResponse.json({ error: 'Referral programme is not currently active' }, { status: 400 });
  }

  // Find user with this referral code
  const referrer = await prisma.user.findUnique({
    where: { referralCode: code },
    select: { id: true, name: true, phone: true },
  });

  if (!referrer) {
    return NextResponse.json({ error: 'Invalid referral code' }, { status: 404 });
  }

  return NextResponse.json({
    valid: true,
    referrerName: referrer.name ?? 'A friend',
    referrerRewardKes: Number(config.referrerRewardKes),
    refereeMatchKes:   Number(config.refereeMatchKes),
  });
}
