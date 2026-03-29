// src/app/api/challenges/[id]/confirm/route.ts
// Mutual consent resolution — each user submits their view of the outcome
// If both agree (or referee submits): auto-resolve at 5% fee
// If no agreement after 48h: escalate to admin (15% fee)

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { initiateTransfer, createTransferRecipient, normalisePhone as formatPhone } from '@/lib/paystack/paystack.service';


const FEE_STANDARD = 0.05;  // 5%  — mutual/referee resolution
const FEE_DISPUTE  = 0.15;  // 15% — admin intervention

const Schema = z.object({
  outcome: z.enum(['USER_A', 'USER_B', 'TIE']),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json();
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { outcome } = parsed.data;

  const challenge = await prisma.marketChallenge.findUnique({
    where: { id: params.id },
    include: {
      userA:   true,
      userB:   true,
      referee: true,
    },
  });

  if (!challenge) return NextResponse.json({ error: 'Challenge not found' }, { status: 404 });
  if (!['ACTIVE', 'PENDING_RESOLUTION'].includes(challenge.status)) {
    return NextResponse.json({ error: 'Challenge is not awaiting resolution' }, { status: 400 });
  }

  const isUserA   = challenge.userAId === user.id;
  const isUserB   = challenge.userBId === user.id;
  const isReferee = challenge.refereeId === user.id;

  if (!isUserA && !isUserB && !isReferee) {
    return NextResponse.json({ error: 'You are not a participant in this challenge' }, { status: 403 });
  }

  // ── REFEREE path — immediate resolution at 5% ────────────────────────────
  if (isReferee && challenge.validatorType === 'REFEREE') {
    if (!challenge.refereeAccepted) {
      return NextResponse.json({ error: 'You must accept the referee nomination first' }, { status: 400 });
    }
    return resolveChallenge(challenge, outcome, FEE_STANDARD, 'REFEREE');
  }

  // ── MUTUAL path — record this user's confirmation ────────────────────────
  const updateData: Record<string, string> = {};
  if (isUserA) updateData.userAConfirm = outcome;
  if (isUserB) updateData.userBConfirm = outcome;

  const updated = await prisma.marketChallenge.update({
    where: { id: challenge.id },
    data:  { ...updateData, status: 'PENDING_RESOLUTION' },
  });

  const aConfirm = isUserA ? outcome : updated.userAConfirm;
  const bConfirm = isUserB ? outcome : updated.userBConfirm;

  // If both parties agree → resolve at standard 5% fee
  if (aConfirm && bConfirm && aConfirm === bConfirm) {
    return resolveChallenge(updated, aConfirm as any, FEE_STANDARD, 'MUTUAL');
  }

  // If both parties disagree AND 48h window has not yet started, start it now
  if (!updated.disputeDeadline) {
    await prisma.marketChallenge.update({
      where: { id: challenge.id },
      data:  { disputeDeadline: new Date(Date.now() + 48 * 60 * 60 * 1000) },
    });
  }

  // Notify the other party
  const otherUser = isUserA ? challenge.userB : challenge.userA;
  if (otherUser) {
    await console.log(otherUser.phone,
      `Rada: Your opponent submitted their result for "${challenge.question.slice(0, 50)}...". ` +
      `Open CheckRada to confirm or dispute. Agree within 48h to keep the 5% Social Challenge fee.`
    );
  }

  return NextResponse.json({
    success: true,
    message: 'Your confirmation recorded. Waiting for the other party.',
    yourOutcome:  outcome,
    theirOutcome: isUserA ? bConfirm : aConfirm,
    agreed:       false,
  });
}

// ── Shared resolution logic ────────────────────────────────────────────────────
async function resolveChallenge(
  challenge: any,
  outcome: 'USER_A' | 'USER_B' | 'TIE',
  feeRate: number,
  method: 'MUTUAL' | 'REFEREE' | 'ADMIN'
) {
  const pool      = Number(challenge.totalPool);
  const feeKes    = Math.floor(pool * feeRate);
  const netPool   = pool - feeKes;

  // Calculate payouts
  let payouts: { userId: string; phone: string; amountKes: number }[] = [];

  if (outcome === 'TIE') {
    const half = Math.floor(netPool / 2);
    payouts = [
      { userId: challenge.userAId, phone: challenge.userA.phone, amountKes: half },
      { userId: challenge.userBId, phone: challenge.userB.phone, amountKes: half },
    ];
  } else {
    const winnerId    = outcome === 'USER_A' ? challenge.userAId : challenge.userBId;
    const winnerPhone = outcome === 'USER_A' ? challenge.userA.phone : challenge.userB?.phone;
    payouts = [{ userId: winnerId, phone: winnerPhone, amountKes: netPool }];
  }

  // Atomic DB update
  await prisma.$transaction(async (tx) => {
    await tx.marketChallenge.update({
      where: { id: challenge.id },
      data: {
        status:        'RESOLVED',
        resolution:    outcome,
        feePercent:    feeRate * 100,
        platformFeeKes: feeKes,
        resolvedAt:    new Date(),
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
          description: `Rada Friends payout (${outcome}) — ${method} resolution. Fee: KES ${feeKes} (${feeRate * 100}%)`,
        },
      });
    }
  });

  // Paystack transfers for challenge payouts
await Promise.allSettled(
  payouts
    .filter(p => p.amountKes > 0 && p.phone)
    .map(async p => {
      const recipient = await createTransferRecipient({
        name:     p.phone,
        phone:    formatPhone(p.phone),
        bankCode: 'MPesa',
      });
      return initiateTransfer({
        amountKes:     p.amountKes,
        recipientCode: recipient.recipient_code,
        reference:     `CKR-CHL-${challenge.id.slice(0,8)}-${p.userId.slice(0,4)}`,
        reason:        'Rada Challenge Payout',
      });
    })
);

  return NextResponse.json({
    success:    true,
    outcome,
    method,
    feePercent: feeRate * 100,
    feeKes,
    netPool,
    payouts:    payouts.map(p => ({ userId: p.userId, amountKes: p.amountKes })),
  });
}
