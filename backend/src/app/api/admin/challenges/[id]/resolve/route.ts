// src/app/api/admin/challenges/[id]/resolve/route.ts
// Admin-forced resolution after 48h dispute window — applies 15% total fee.
//
// Payout model: winnings credited to CheckRada wallet balance only.
// Users withdraw to M-Pesa manually via the standard withdrawal flow.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';
import { withErrorHandling } from '@/lib/security/route-guard';

export const dynamic = 'force-dynamic';

const FEE_ADMIN    = 0.15; // 15% when admin must intervene
const FEE_STANDARD = 0.05; // 5%  — when both parties already agreed

const Schema = z.object({
  outcome: z.enum(['USER_A', 'USER_B', 'TIE']),
  reason:  z.string().optional(),
});

export const POST = withErrorHandling(async function POST(
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
  if (!challenge.userA || !challenge.userB) {
    return NextResponse.json({ error: 'Challenge participants no longer exist' }, { status: 400 });
  }
  if (!['ACTIVE', 'PENDING_RESOLUTION', 'DISPUTED'].includes(challenge.status)) {
    return NextResponse.json({ error: 'Challenge is not in a disputable state' }, { status: 400 });
  }

  // If both parties already submitted matching outcomes, apply 5% fee not 15%
  const bothAgreed = challenge.userAConfirm && challenge.userBConfirm &&
                     challenge.userAConfirm === challenge.userBConfirm;

  // Verify the 48h window has actually expired (or admin is force-resolving a DISPUTED one)
  // Bypass for mutual agreements — both parties consented so no need to wait
  const now = new Date();
  if (
    !bothAgreed &&
    challenge.status !== 'DISPUTED' &&
    challenge.disputeDeadline &&
    challenge.disputeDeadline > now
  ) {
    const hoursLeft = Math.ceil((challenge.disputeDeadline.getTime() - now.getTime()) / 3600000);
    return NextResponse.json({
      error: `Dispute window has not expired yet. ${hoursLeft}h remaining.`,
    }, { status: 400 });
  }

  const actualFeeRate = bothAgreed ? FEE_STANDARD : FEE_ADMIN;
  const actualMethod  = bothAgreed ? 'MUTUAL' : 'ADMIN';

  const pool    = Number(challenge.totalPool);
  const feeKes  = Math.floor(pool * actualFeeRate);
  const netPool = pool - feeKes;

  // Calculate payouts
  let payouts: { userId: string; phone: string; amountKes: number }[] = [];
  if (outcome === 'TIE') {
    const half = Math.floor(netPool / 2);
payouts = [
  { userId: challenge.userAId, phone: challenge.userA.phone, amountKes: half },
  { userId: challenge.userBId, phone: challenge.userB.phone, amountKes: netPool - half },
];
  } else {
    const winner = outcome === 'USER_A' ? challenge.userA : challenge.userB!;
    payouts = [{ userId: winner.id, phone: winner.phone, amountKes: netPool }];
  }

  // Atomic resolution — wallet credit only
  let alreadyResolved = false;
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.marketChallenge.updateMany({
  where: { id: challenge.id, status: { in: ['ACTIVE', 'PENDING_RESOLUTION', 'DISPUTED'] }, resolution: null },
  data: { status: 'RESOLVED', resolution: outcome, feePercent: actualFeeRate * 100, platformFeeKes: feeKes, resolvedAt: new Date() },
});
if (claimed.count === 0) throw new Error('Challenge already resolved — concurrent resolve blocked');

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
          status:      'SUCCESS', // wallet credit is the completed payout
          description: `Challenge payout (${outcome}) — ${actualMethod} resolution via admin. Fee: KES ${feeKes} (${actualFeeRate * 100}%). Credited to CheckRada wallet.`,
        },
      });
    }

    // Only degrade integrity scores for genuine disputes, not mutual agreements
    if (!bothAgreed) {
      if (challenge.userAId) {
        await tx.user.update({ where: { id: challenge.userAId }, data: { integrityScore: { decrement: 10 } } });
      }
      if (challenge.userBId) {
        await tx.user.update({ where: { id: challenge.userBId }, data: { integrityScore: { decrement: 10 } } });
      }
    }

    // M-5 FIX: platformRevenue.create is inside the $transaction — atomically
    // committed or rolled back with the wallet credits above.
    if (feeKes > 0) {
      await tx.platformRevenue.create({
        data: {
          challengeId: challenge.id,
          type:        'CHALLENGE_FEE',
          amountKes:   feeKes,
          description: `Challenge fee (${actualFeeRate * 100}%) — ${actualMethod} resolution via admin. Question: "${challenge.question.slice(0, 60)}"`,
        },
      });
    }
  }).catch((err: any) => {
    if (err.message?.includes('already resolved')) { alreadyResolved = true; return; }
    throw err;
  });

  if (alreadyResolved) {
    return NextResponse.json({ success: true, alreadyResolved: true, message: 'Challenge already resolved.' });
  }

  // No M-Pesa direct transfer — winnings are in the user's CheckRada wallet.
  // Users withdraw to M-Pesa via the standard withdrawal flow at their convenience.

  // M-5: platformRevenue.create is now inside the $transaction above — removed from here

  // Log admin action
  await logAdminAction(admin.id, 'DISPUTE_RESOLVED', `challenge:${challenge.id}`, { outcome, feeKes, reason }, req);

  console.log(`[CHALLENGE RESOLVE] Challenge ${challenge.id} resolved as ${outcome} by admin. Fee: KES ${feeKes}. Net pool: KES ${netPool}.`);

  return NextResponse.json({
    success:    true,
    outcome,
    feePercent: actualFeeRate * 100,
    feeKes,
    netPool,
    payouts: payouts.map(p => ({ userId: p.userId, amountKes: p.amountKes })),
  });
});
