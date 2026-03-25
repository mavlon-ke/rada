// src/app/api/admin/challenges/[id]/resolve/route.ts
// Admin-forced resolution after 48h dispute window — applies 15% total fee

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';
import { initiateB2C, formatPhone } from '@/lib/mpesa/mpesa.service';

const FEE_ADMIN = 0.15; // 15% when admin must intervene

const Schema = z.object({
  outcome: z.enum(['USER_A', 'USER_B', 'TIE']),
  reason:  z.string().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const body   = await req.json();
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { outcome, reason } = parsed.data;

  const challenge = await prisma.marketChallenge.findUnique({
    where: { id: params.id },
    include: {
      userA: true,
      userB: true,
    },
  });

  if (!challenge) return NextResponse.json({ error: 'Challenge not found' }, { status: 404 });
  if (!['ACTIVE', 'PENDING_RESOLUTION', 'DISPUTED'].includes(challenge.status)) {
    return NextResponse.json({ error: 'Challenge is not in a disputable state' }, { status: 400 });
  }

  // Verify the 48h window has actually expired (or admin is force-resolving a DISPUTED one)
  const now = new Date();
  if (
    challenge.status !== 'DISPUTED' &&
    challenge.disputeDeadline &&
    challenge.disputeDeadline > now
  ) {
    const hoursLeft = Math.ceil((challenge.disputeDeadline.getTime() - now.getTime()) / 3600000);
    return NextResponse.json({
      error: `Dispute window has not expired yet. ${hoursLeft}h remaining.`,
    }, { status: 400 });
  }

  const pool    = Number(challenge.totalPool);
  const feeKes  = Math.floor(pool * FEE_ADMIN);
  const netPool = pool - feeKes;

  // Calculate payouts
  let payouts: { userId: string; phone: string; amountKes: number }[] = [];
  if (outcome === 'TIE') {
    const half = Math.floor(netPool / 2);
    payouts = [
      { userId: challenge.userAId, phone: challenge.userA.phone, amountKes: half },
      { userId: challenge.userBId!, phone: challenge.userB!.phone, amountKes: half },
    ];
  } else {
    const winner = outcome === 'USER_A' ? challenge.userA : challenge.userB!;
    payouts = [{ userId: winner.id, phone: winner.phone, amountKes: netPool }];
  }

  // Atomic resolution
  await prisma.$transaction(async (tx) => {
    await tx.marketChallenge.update({
      where: { id: challenge.id },
      data: {
        status:         'RESOLVED',
        resolution:     outcome,
        feePercent:     FEE_ADMIN * 100,
        platformFeeKes: feeKes,
        resolvedAt:     new Date(),
      },
    });

    for (const p of payouts.filter(p => p.amountKes > 0)) {
      const updated = await tx.user.update({
        where: { id: p.userId },
        data:  { balanceKes: { increment: p.amountKes } },
      });
      await tx.transaction.create({
        data: {
          userId:      p.userId,
          challengeId: challenge.id,
          type:        'CHALLENGE_PAYOUT',
          amountKes:   p.amountKes,
          balAfter:    Number(updated.balanceKes),
          status:      'PENDING',
          description: `CheckRada admin dispute resolution — Social Challenge (${outcome}). Fee: KES ${feeKes} (15%)`,
        },
      });
    }

    // Degrade integrity scores for both disputants
    await tx.user.update({ where: { id: challenge.userAId }, data: { integrityScore: { decrement: 10 } } });
    if (challenge.userBId) {
      await tx.user.update({ where: { id: challenge.userBId }, data: { integrityScore: { decrement: 10 } } });
    }
  });

  // Log admin action
  await logAdminAction(admin.id, 'DISPUTE_RESOLVED', `challenge:${challenge.id}`, { outcome, feeKes, reason }, req);

  // Trigger B2C
  await Promise.allSettled(
    payouts
      .filter(p => p.amountKes > 0 && p.phone)
      .map(p => initiateB2C({
        phone:     formatPhone(p.phone),
        amountKes: p.amountKes,
        remarks:   'CheckRada Dispute Payout',
        occasion:  `Challenge: ${challenge.id}`,
      }))
  );

  return NextResponse.json({
    success:    true,
    outcome,
    feePercent: FEE_ADMIN * 100,
    feeKes,
    netPool,
    payouts: payouts.map(p => ({ userId: p.userId, amountKes: p.amountKes })),
  });
}
