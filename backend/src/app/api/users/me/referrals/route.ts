// src/app/api/users/me/referrals/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';

export async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [config, referrals] = await Promise.all([
    prisma.referralConfig.findUnique({ where: { id: 'singleton' } }),
    prisma.referral.findMany({
      where:   { referrerId: user.id },
      include: { referee: { select: { name: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const totalEarned = referrals.reduce(
    (sum, r) => sum + Number(r.referrerRewardKes), 0
  );

  // Dynamically generate the share message using current config amounts
  const refereeReward = Number(config?.refereeMatchKes ?? 50);
  const referralCode  = (await prisma.user.findUnique({
    where:  { id: user.id },
    select: { referralCode: true },
  }))?.referralCode ?? '';

  const shareMessage = `I've been using Rada to predict Kenyan events outcomes and winning real money. Join me — use my code ${referralCode} and we both get KES ${refereeReward}. rada.co.ke/join/${referralCode}`;

  return NextResponse.json({
    referralCode,
    referrals,
    totalReferred: referrals.length,
    totalEarned,
    shareMessage,
    programmeActive: config?.active ?? false,
    referrerRewardKes: Number(config?.referrerRewardKes ?? 50),
    refereeRewardKes:  refereeReward,
  });
}
