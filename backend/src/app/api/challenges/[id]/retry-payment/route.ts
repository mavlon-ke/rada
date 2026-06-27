// src/app/api/challenges/[id]/retry-payment/route.ts
// Challenger A retries the M-Pesa payment for a PENDING_PAYMENT challenge.
//
// Recalculates at current wallet balance:
//   - If wallet now covers remaining shortfall → completes immediately (no M-Pesa)
//   - If still shortfall → cancels old pending tx, fires fresh STK push
//
// The remaining shortfall = stakePerPerson - totalPool (what wallet has already covered).

import { NextRequest, NextResponse } from 'next/server';
import { prisma }             from '@/lib/db/prisma';
import { requireAuth }        from '@/lib/auth/session';
import { createNotification } from '@/lib/notifications';
import { displayName }        from '@/lib/user/display-name';
import {
  chargeMpesa,
  generateReference,
  normalisePhone,
} from '@/lib/paystack/paystack.service';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const challenge = await prisma.marketChallenge.findUnique({
    where:   { id: params.id },
    include: {
      userB:   { select: { id: true, name: true, phone: true } },
      referee: { select: { id: true, name: true, phone: true } },
    },
  });

  if (!challenge) return NextResponse.json({ error: 'Challenge not found' }, { status: 404 });
  if (challenge.userAId !== user.id) {
    return NextResponse.json({ error: 'Only the challenge creator can retry payment' }, { status: 403 });
  }
  if (challenge.status !== 'PENDING_PAYMENT') {
    return NextResponse.json({ error: 'Challenge is not awaiting payment' }, { status: 400 });
  }

  const stake     = Number(challenge.stakePerPerson);
  const paidSoFar = Number(challenge.totalPool);  // wallet portion already deducted
  const remaining = Math.max(0, stake - paidSoFar);

  if (remaining === 0) {
    // Already fully paid — just activate
    await prisma.marketChallenge.update({
      where: { id: challenge.id },
      data:  { status: 'PENDING_JOIN' },
    });
    return NextResponse.json({ success: true, method: 'wallet', message: 'Challenge activated!' });
  }

  // Read fresh balances
  const freshUser = await prisma.user.findUnique({
    where:  { id: user.id },
    select: { balanceKes: true, bonusBalanceKes: true, phone: true },
  });
  if (!freshUser) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const realBal  = Number(freshUser.balanceKes);
  const bonusBal = Number(freshUser.bonusBalanceKes);
  const walletAvailable = realBal + bonusBal;

  // Cancel any existing pending CHALLENGE_STAKE tx for this challenge
  // so the old Paystack reference can't accidentally activate the challenge later
  await prisma.transaction.updateMany({
    where: { challengeId: challenge.id, status: 'PENDING', type: 'CHALLENGE_STAKE' },
    data:  { status: 'CANCELLED', description: 'Superseded by retry payment request' },
  });

  // ── Wallet now covers remaining shortfall → complete immediately ───────────
  if (walletAvailable >= remaining) {
    let actualRealUsed  = 0;
    let actualBonusUsed = 0;

    await prisma.$transaction(async (tx: any) => {
      const u = await tx.user.findUnique({ where: { id: user.id } });
      const curReal  = Number(u.balanceKes);
      const curBonus = Number(u.bonusBalanceKes);
      actualRealUsed  = Math.min(curReal,  remaining);
      actualBonusUsed = Math.min(curBonus, Math.max(0, remaining - actualRealUsed));

      const updateData: any = {};
      if (actualRealUsed  > 0) updateData.balanceKes      = { decrement: actualRealUsed  };
      if (actualBonusUsed > 0) updateData.bonusBalanceKes = { decrement: actualBonusUsed };

      // Guard: race condition could leave pool underfunded — fail fast
      if (actualRealUsed + actualBonusUsed < remaining) {
        throw new Error('Insufficient balance — please top up and retry');
      }

      if (Object.keys(updateData).length > 0) {
        await tx.user.update({ where: { id: user.id }, data: updateData });
      }

      await tx.marketChallenge.update({
        where: { id: challenge.id },
        data:  { totalPool: { increment: remaining }, status: 'PENDING_JOIN' },
      });

      await tx.transaction.create({
        data: {
          userId:      user.id,
          challengeId: challenge.id,
          type:        actualBonusUsed > 0 ? 'BONUS_USED' : 'CHALLENGE_STAKE',
          amountKes:   -(actualRealUsed + actualBonusUsed),
          balAfter:    curReal - actualRealUsed,
          status:      'SUCCESS',
          description: 'Challenge payment retry — wallet shortfall covered',
        },
      });
    });

    // Notify B now that challenge is PENDING_JOIN
    if (challenge.userBId && challenge.userB) {
      void createNotification({
        userId:  challenge.userBId,
        type:    'CHALLENGE_OPPONENT_STAKED',
        title:   "⚡ You've been challenged!",
        message: displayName(user.name, freshUser.phone) + ' challenged you: "' + challenge.question.slice(0, 60) + '". Code: ' + challenge.accessCode,
        link:    '/join/' + challenge.accessCode,
        whatsapp: {
          template:   'CHALLENGE_OPPONENT_STAKED',
          parameters: [displayName(user.name, freshUser.phone), stake.toLocaleString()],
        },
      });
    }
    if (challenge.refereeId && challenge.referee) {
      void createNotification({
        userId:  challenge.refereeId,
        type:    'REFEREE_NOMINATED',
        title:   "⚖️ You've been nominated as referee",
        message: displayName(user.name, freshUser.phone) + ' nominated you to referee a challenge. Code: ' + challenge.accessCode,
        link:    '/rada-friends.html',
        whatsapp: { template: 'REFEREE_NOMINATED', parameters: [displayName(user.name, freshUser.phone)] },
      });
    }

    return NextResponse.json({
      success: true,
      method:  'wallet',
      message: 'Challenge activated! Your wallet covered the remaining balance.',
    });
  }

  // ── Still a shortfall → fire fresh STK push for remaining amount ──────────
  const ref            = generateReference('CHG');
  const formattedPhone = normalisePhone(freshUser.phone);
  const email          = formattedPhone.replace('+', '') + '@checkrada.co.ke';

  try {
    await prisma.transaction.create({
      data: {
        userId:      user.id,
        challengeId: challenge.id,
        type:        'CHALLENGE_STAKE',
        amountKes:   remaining,
        balAfter:    realBal,
        phone:       formattedPhone,
        mpesaRef:    ref,
        status:      'PENDING',
        description: 'Challenge payment retry (M-Pesa): KES ' + remaining + ' for "' + challenge.question.slice(0, 50) + '"',
      },
    });

    const stkResult = await chargeMpesa({
      email,
      amountKes:  remaining,
      phone:      formattedPhone,
      reference:  ref,
      metadata: {
        userId:      user.id,
        challengeId: challenge.id,
        platform:    'checkrada',
        paymentType: 'challenge_stake_retry',
      },
    });

    return NextResponse.json({
      success:    true,
      method:     'mpesa',
      stkMessage: stkResult.display_text || 'Check your phone for an M-Pesa prompt — KES ' + remaining + '.',
      remaining,
    });
  } catch (err: any) {
    return NextResponse.json({
      error: 'Could not initiate M-Pesa payment: ' + err.message + '. Please try again or top up your wallet first.',
    }, { status: 500 });
  }
}
