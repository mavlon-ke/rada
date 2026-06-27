// src/app/api/challenges/join/[code]/route.ts
// GET  — look up a challenge by access code (preview before staking)
// POST — join the challenge and stake your amount
//
// Locked challenges (userBId set at creation): only the pre-assigned user can join.
// Open challenges (userBId null): first registered user with the code wins the slot.
//
// Payment: wallet-first (real → bonus). B must have full stake in wallet before joining.

import { NextRequest, NextResponse } from 'next/server';
import { prisma }             from '@/lib/db/prisma';
import { requireAuth }        from '@/lib/auth/session';
import { createNotification } from '@/lib/notifications';
import { displayName }        from '@/lib/user/display-name';
import { normalisePhone } from '@/lib/paystack/paystack.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: { code: string } }
) {
  const challenge = await prisma.marketChallenge.findUnique({
    where:   { accessCode: params.code.toUpperCase() },
    include: {
      userA:   { select: { name: true, phone: true } },
      referee: { select: { name: true, phone: true } },
    },
  });

  if (!challenge) return NextResponse.json({ error: 'Challenge not found' }, { status: 404 });
  if (challenge.status !== 'PENDING_JOIN') {
    return NextResponse.json({ error: 'This challenge is no longer open to join' }, { status: 400 });
  }

  return NextResponse.json({
    challengeId:    challenge.id,
    question:       challenge.question,
    stakePerPerson: Number(challenge.stakePerPerson),
    eventExpiresAt: challenge.eventExpiresAt,
    validatorType:  challenge.validatorType,
    createdBy:      displayName(challenge.userA.name, challenge.userA.phone),
    challengerAAlias: challenge.challengerAAlias || null,
    challengerBAlias: challenge.challengerBAlias || null,
    hasReferee:     !!challenge.refereeId,
    refereeName:    challenge.referee ? displayName(challenge.referee.name, challenge.referee.phone) : null,
    isLocked:       !!challenge.userBId,   // true = only pre-assigned user can join
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { code: string } }
) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const challenge = await prisma.marketChallenge.findUnique({
    where:   { accessCode: params.code.toUpperCase() },
    include: { userA: { select: { phone: true, name: true } } },
  });

  if (!challenge) {
    return NextResponse.json({ error: 'Challenge not found' }, { status: 404 });
  }
  if (challenge.status !== 'PENDING_JOIN') {
    return NextResponse.json({ error: 'This challenge is no longer open to join' }, { status: 400 });
  }
  if (challenge.userAId === user.id) {
    return NextResponse.json({ error: 'You created this challenge' }, { status: 400 });
  }

  // ── Locked challenge: enforce pre-assigned Challenger B ───────────────────
  if (challenge.userBId && challenge.userBId !== user.id) {
    return NextResponse.json({
      error: 'This challenge is reserved for a specific person and cannot be joined with this code.',
    }, { status: 403 });
  }

  const stake = Number(challenge.stakePerPerson);

  // ── Read fresh balances for wallet-first calculation ─────────────────────
  // Never use balanceKes from requireAuth — it may be stale or undefined.
  const freshUser = await prisma.user.findUnique({
    where:  { id: user.id },
    select: { balanceKes: true, bonusBalanceKes: true, phone: true },
  });
  if (!freshUser) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const realBal  = Number(freshUser.balanceKes);
  const bonusBal = Number(freshUser.bonusBalanceKes);
  const walletTotal = realBal + bonusBal;

  // B must have full stake in wallet. No M-Pesa STK push at join time —
  // if B misses the prompt or enters the wrong PIN there is no retry path.
  // They should deposit first, then join.
  if (walletTotal < stake) {
    const shortfall = Math.ceil(stake - walletTotal);
    return NextResponse.json({
      error: `Insufficient balance. You need KES ${shortfall.toLocaleString()} more to join. Please deposit first then try again.`,
    }, { status: 400 });
  }

  const realUsed  = Math.min(realBal,  stake);
  const bonusUsed = Math.min(bonusBal, Math.max(0, stake - realUsed));

  // ── Atomic transaction: deduct wallet + activate challenge ────────────────
  // actualRealUsed / actualBonusUsed are set inside tx and used for the transaction record
  let actualRealUsed  = 0;
  let actualBonusUsed = 0;

  const updated = await prisma.$transaction(async (tx: any) => {
    const u = await tx.user.findUnique({ where: { id: user.id } });
    if (!u) throw new Error('User not found');

    const curReal  = Number(u.balanceKes);
    const curBonus = Number(u.bonusBalanceKes);
    // Use stake (not walletTotal) — walletTotal is the balance check total, not deduction amount
    actualRealUsed  = Math.min(curReal,  stake);
    actualBonusUsed = Math.min(curBonus, Math.max(0, stake - actualRealUsed));
    const actualWalletTotal = actualRealUsed + actualBonusUsed;

    if (actualWalletTotal < stake) throw new Error('Insufficient balance');

    const updateData: any = {};
    if (actualRealUsed  > 0) updateData.balanceKes      = { decrement: actualRealUsed  };
    if (actualBonusUsed > 0) updateData.bonusBalanceKes = { decrement: actualBonusUsed };
    if (Object.keys(updateData).length > 0) {
      await tx.user.update({ where: { id: user.id }, data: updateData });
    }

    const ch = await tx.marketChallenge.update({
      where: { id: challenge.id },
      data: {
        userBId:   user.id,
        totalPool: { increment: actualWalletTotal },   // stake amount paid, not total balance
        status:    'ACTIVE',
      },
    });

    if (actualWalletTotal > 0) {
      await tx.transaction.create({
        data: {
          userId:      user.id,
          challengeId: ch.id,
          type:        actualBonusUsed > 0 ? 'BONUS_USED' : 'CHALLENGE_STAKE',
          amountKes:   -actualWalletTotal,
          balAfter:    curReal - actualRealUsed,
          status:      'SUCCESS',
          description: `Joined challenge: "${challenge.question.slice(0, 60)}"`,
        },
      });
    }

    return ch;
  });

  // ── Notify creator ────────────────────────────────────────────────────────
  const joinerName = displayName(user.name, freshUser.phone);
  void createNotification({
    userId:  challenge.userAId,
    type:    'CHALLENGE_OPPONENT_STAKED',
    title:   '🤝 Challenge accepted!',
    message: `${joinerName} accepted your challenge "${challenge.question.slice(0, 50)}...". Pool: KES ${Number(updated.totalPool).toLocaleString()}`,
    link:    '/rada-friends.html',
    whatsapp: {
      template:   'CHALLENGE_OPPONENT_STAKED',
      parameters: [joinerName, Number(updated.totalPool).toLocaleString()],
    },
  });

  return NextResponse.json({
    success:     true,
    challengeId: updated.id,
    status:      'ACTIVE',
    payment: {
      walletUsed: walletTotal,
    },
  });
}
