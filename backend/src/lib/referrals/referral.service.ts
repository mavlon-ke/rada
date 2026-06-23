// src/lib/referrals/referral.service.ts
// Referral programme business logic.
//
// Flow:
//   1. Referee registers with a referral code → Referral row created (PENDING).
//      See otp/verify/route.ts.
//
//   2. Referee's CUMULATIVE deposits reach minDepositKes
//      → referee receives bonusBalanceKes (non-withdrawable, used to subsidise trades)
//      → Referral.refereeRewardKes stamped (used as deposit-milestone flag)
//      → Status stays PENDING (waiting for trade milestone)
//      Called by: Paystack webhook after each successful deposit.
//
//   3. Referee's CUMULATIVE gross trade volume reaches minTradeKes
//      → referrer receives real balanceKes (withdrawable)
//      → Referral.referrerRewardKes stamped
//      → Status → REWARDED
//      Called by: trade/route.ts on every trade (service guards internally).
//
// Toggle: if config.active is false, neither step 2 nor step 3 fires.
//         Referral rows are still created and tracked regardless.
//
// Scam protection:
//   - Deposit milestone must be hit before trade milestone (Referral.refereeRewardKes > 0 guard)
//   - Trade minimum should be ≥ deposit minimum to prevent deposit-then-withdraw abuse
//   - Double-credit protected: refereeRewardKes > 0 (deposit) and status !== PENDING (trade)

import { prisma }             from '@/lib/db/prisma';
import { createNotification } from '@/lib/notifications';

// ── 1. Credit referee bonus on cumulative deposit milestone ──────────────────
//
// Called from the Paystack webhook after every confirmed deposit.
// Sums ALL successful deposits for this user — fires once when the cumulative
// total first crosses minDepositKes.
//
// Awards bonusBalanceKes (non-withdrawable). Bonus is consumed naturally as the
// referee stakes on markets. Any winnings from the bonus become real balance.
//
// Idempotent: Referral.refereeRewardKes > 0 means bonus was already credited.

export async function creditRefereeBonusOnDeposit(
  refereeUserId: string,
  _depositAmountKes: number   // kept for backward compat with webhook call signature
): Promise<{ credited: boolean; amountKes: number }> {

  const config = await prisma.referralConfig.findUnique({ where: { id: 'singleton' } });
  if (!config?.active) return { credited: false, amountKes: 0 };

  const referral = await prisma.referral.findUnique({
    where: { refereeId: refereeUserId },
  });
  if (!referral || referral.status !== 'PENDING') return { credited: false, amountKes: 0 };

  // Idempotency: already credited on a prior deposit
  if (Number(referral.refereeRewardKes) > 0) return { credited: false, amountKes: 0 };

  const minDeposit = Number(config.minDepositKes);
  const refereeBonus = Number(config.refereeMatchKes);
  if (refereeBonus <= 0) return { credited: false, amountKes: 0 };

  // Sum ALL successful deposits for this user — cumulative threshold check
  const depositAgg = await prisma.transaction.aggregate({
    where: { userId: refereeUserId, type: 'DEPOSIT', status: 'SUCCESS' },
    _sum:  { amountKes: true },
  });
  const totalDeposited = Number(depositAgg._sum.amountKes ?? 0);
  if (totalDeposited < minDeposit) return { credited: false, amountKes: 0 };

  // Credit referee bonus and stamp the referral row
  await prisma.$transaction(async (tx: any) => {
    const updated = await tx.user.update({
      where: { id: refereeUserId },
      data:  { bonusBalanceKes: { increment: refereeBonus } },
    });

    // Record the bonus in the user's transaction ledger
    await tx.transaction.create({
      data: {
        userId:      refereeUserId,
        type:        'REFERRAL_REWARD',
        amountKes:   refereeBonus,
        balAfter:    Number(updated.balanceKes),
        status:      'SUCCESS',
        description: `Referral welcome bonus — KES ${refereeBonus} to use on your first forecasts. Make your first trades to unlock your referrer's reward.`,
      },
    });

    // Stamp refereeRewardKes — this becomes the deposit-milestone flag for step 3
    await tx.referral.update({
      where: { refereeId: refereeUserId },
      data:  { refereeRewardKes: refereeBonus },
    });
  });

  // Notify referee (fire-and-forget)
  void createNotification({
    userId:  refereeUserId,
    type:    'REFERRAL_REWARD_CREDITED',
    title:   '🎁 Welcome bonus credited!',
    message: `KES ${refereeBonus} bonus added to your account — use it to place your first forecasts on CheckRada.`,
    link:    '/rada-dashboard.html',
  }).catch(() => {});

  console.log(`[Referral] Referee bonus KES ${refereeBonus} credited to ${refereeUserId}. Total deposited: KES ${totalDeposited}.`);
  return { credited: true, amountKes: refereeBonus };
}

// ── 2. Pay referrer when cumulative trade volume milestone is reached ─────────
//
// Called from INSIDE the trade-route $transaction on every trade the referee makes.
// The function is cheap to call repeatedly — it early-returns on most paths.
//
// Guards (in order):
//   1. Referral exists and is PENDING (not already REWARDED)
//   2. Deposit milestone was hit (refereeRewardKes > 0)
//   3. Cumulative gross trade volume ≥ minTradeKes
//      (current order is INCLUDED — it was created earlier in the same tx)
//
// On success: credits referrer real balance, stamps referral REWARDED.

export async function payReferrerOnFirstTrade(
  tx: any,
  refereeUserId: string
): Promise<{ paid: number; referrerId: string | null }> {

  const config = await tx.referralConfig.findUnique({ where: { id: 'singleton' } });
  if (!config?.active) return { paid: 0, referrerId: null };

  const referral = await tx.referral.findUnique({
    where: { refereeId: refereeUserId },
  });
  if (!referral || referral.status !== 'PENDING') return { paid: 0, referrerId: null };

  // Guard: deposit milestone must be reached first
  if (Number(referral.refereeRewardKes) === 0) return { paid: 0, referrerId: null };

  const minTrade = Number(config.minTradeKes);
  const referrerReward = Number(config.referrerRewardKes);
  if (referrerReward <= 0) return { paid: 0, referrerId: referral.referrerId };

  // Cumulative gross trade volume — current order already exists in tx
  const tradeAgg = await tx.order.aggregate({
    where: { userId: refereeUserId },
    _sum:  { amountKes: true },
  });
  const totalTraded = Number(tradeAgg._sum.amountKes ?? 0);
  if (totalTraded < minTrade) return { paid: 0, referrerId: null };

  // Pay referrer — real withdrawable balance
  const referrerUpdated = await tx.user.update({
    where: { id: referral.referrerId },
    data:  { balanceKes: { increment: referrerReward } },
  });

  await tx.transaction.create({
    data: {
      userId:      referral.referrerId,
      type:        'REFERRAL_REWARD',
      amountKes:   referrerReward,
      balAfter:    Number(referrerUpdated.balanceKes),
      status:      'SUCCESS',
      description: `Referral reward — your referred user reached the KES ${minTrade} trade milestone.`,
    },
  });

  // Stamp referral REWARDED
  await tx.referral.update({
    where: { refereeId: refereeUserId },
    data:  {
      status:            'REWARDED',
      referrerRewardKes: referrerReward,
      rewardPaidAt:      new Date(),
    },
  });

  console.log(`[Referral] Referrer ${referral.referrerId} paid KES ${referrerReward}. Referee ${refereeUserId} reached KES ${totalTraded} trade volume.`);
  return { paid: referrerReward, referrerId: referral.referrerId };
}

// ── Notify referrer (fire-and-forget) ────────────────────────────────────────
// Called by trade/route.ts after the transaction commits.

export async function notifyReferrerRewarded(
  referrerId: string,
  amountKes: number
): Promise<void> {
  try {
    await createNotification({
      userId:  referrerId,
      type:    'REFERRAL_REWARD_CREDITED',
      title:   '🎉 Referral reward earned!',
      message: `KES ${amountKes} credited to your wallet — your referral hit the trading milestone.`,
      link:    '/rada-portfolio.html',
      whatsapp: {
        template:   'REFERRAL_REWARD_CREDITED',
        parameters: [String(amountKes)],
      },
    });
  } catch {
    /* notifications are best-effort */
  }
}
