// src/app/api/payments/mpesa/callback/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { parseSTKCallback, STKCallbackBody } from '@/lib/mpesa/mpesa.service';
import { createNotification } from '@/lib/notifications';

export async function POST(req: NextRequest) {
  const body: STKCallbackBody = await req.json();
  const parsed = parseSTKCallback(body);

  const transaction = await prisma.transaction.findFirst({
    where: { mpesaRef: parsed.checkoutRequestId },
  });

  if (!transaction) {
    console.error('Unknown checkout request:', parsed.checkoutRequestId);
    return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  if (!parsed.success) {
    await prisma.transaction.update({
      where: { id: transaction.id },
      data:  { status: 'FAILED' },
    });
    return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  // ── Success: credit user's balance ─────────────────────────────────────────
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: transaction.userId },
      data:  { balanceKes: { increment: Number(transaction.amountKes) } },
    });

    const updatedUser = await tx.user.findUnique({ where: { id: transaction.userId } });

    await tx.transaction.update({
      where: { id: transaction.id },
      data: {
        status:   'SUCCESS',
        mpesaRef: parsed.mpesaRef,
        balAfter: Number(updatedUser!.balanceKes),
      },
    });
  });

  // ── Referral reward: trigger on first qualifying deposit ───────────────────
  try {
    const config = await prisma.referralConfig.findUnique({ where: { id: 'singleton' } });
    const depositAmount = Number(transaction.amountKes);

    if (config?.active && depositAmount >= Number(config.minDepositKes)) {
      // Check if there's a pending referral for this user
      const referral = await prisma.referral.findUnique({
        where:   { refereeId: transaction.userId },
        include: { referrer: true, referee: true },
      });

      if (referral && referral.status === 'PENDING') {
        // Check this is their first successful deposit
        const priorDeposits = await prisma.transaction.count({
          where: {
            userId: transaction.userId,
            type:   'DEPOSIT',
            status: 'SUCCESS',
            id:     { not: transaction.id },
          },
        });

        if (priorDeposits === 0) {
          // ── Qualify and reward ──
          const referrerReward = Number(config.referrerRewardKes);
          const refereeReward  = Number(config.refereeMatchKes);  // bonus balance (forecast-locked)

          await prisma.$transaction(async (tx) => {
            // Mark referral as qualified
            await tx.referral.update({
              where: { refereeId: transaction.userId },
              data: {
                status:            'QUALIFIED',
                referrerRewardKes: referrerReward,
                refereeRewardKes:  refereeReward,
              },
            });

            // Credit referrer with real balance (KES 50)
            await tx.user.update({
              where: { id: referral.referrerId },
              data:  { bonusBalanceKes: { increment: referrerReward } },
            });

            // Credit referee with bonus balance (forecast-locked)
            await tx.user.update({
              where: { id: transaction.userId },
              data:  { bonusBalanceKes: { increment: refereeReward } },
            });

            // Referrer transaction record
            await tx.transaction.create({
              data: {
                userId:      referral.referrerId,
                type:        'REFERRAL_REWARD',
                amountKes:   referrerReward,
                balAfter:    0,  // will be accurate on next balance read
                status:      'SUCCESS',
                description: `Referral reward: ${referral.referee.name ?? referral.referee.phone} joined Rada`,
              },
            });

            // Referee transaction record
            await tx.transaction.create({
              data: {
                userId:      transaction.userId,
                type:        'REFERRAL_REWARD',
                amountKes:   refereeReward,
                balAfter:    0,
                status:      'SUCCESS',
                description: `Welcome bonus — forecast KES ${refereeReward} to unlock for withdrawal`,
              },
            });
          });

          // Notify both parties
          await createNotification({
            userId:  referral.referrerId,
            type:    'REFERRAL_REWARD_CREDITED',
            title:   '🎁 Referral Reward!',
            message: `${referral.referee.name ?? 'Your friend'} joined CheckRada! KES ${referrerReward} bonus credited. Forecast to unlock for withdrawal.`,
            link:    '/rada-portfolio.html',
          });

          await createNotification({
            userId:  transaction.userId,
            type:    'REFERRAL_REWARD_CREDITED',
            title:   '🎁 Welcome Bonus!',
            message: `KES ${refereeReward} bonus credited to your account. Place a forecast to unlock it for withdrawal.`,
            link:    '/rada-markets.html',
          });
        }
      }
    }
  } catch (err) {
    // Never let referral logic crash the deposit confirmation
    console.error('[Referral] Error processing referral reward:', err);
  }

  // ── Notify user of successful deposit ─────────────────────────────────────
  try {
    const user = await prisma.user.findUnique({ where: { id: transaction.userId } });
    await createNotification({
      userId:  transaction.userId,
      type:    'DEPOSIT_CONFIRMED',
      title:   '✅ Deposit Confirmed',
      message: `KES ${Number(transaction.amountKes).toLocaleString()} deposited. Balance: KES ${Number(user!.balanceKes).toLocaleString()}`,
      link:    '/rada-portfolio.html',
    });
  } catch (_) {}

  return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}
