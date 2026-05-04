// src/lib/referrals/referral.service.ts
// Referral programme business logic — kept separate from payment infrastructure.
//
// Two milestones:
//   1. Referee makes first qualifying deposit  → credit referee bonus money
//   2. Referee makes first trade               → credit referrer's real balance + transition status
//
// Both functions are designed to be called from inside a payment-/trade-flow
// transaction OR standalone. When called inside a transaction, pass the tx
// client; otherwise the helpers use prisma directly.
//
// Idempotency: each helper guards against double-credit so multiple deposits
// or trades from the same referee will not stack rewards.

import { prisma } from '@/lib/db/prisma';
import { createNotification } from '@/lib/notifications';

// ─── Helper: credit referee bonus on first qualifying deposit ────────────────
//
// Called from the Paystack webhook (or any future payment provider's
// equivalent) after a deposit is confirmed. Credits the referee's
// `bonusBalanceKes` so they have promotional money to stake on their first
// trade. Does NOT touch the referrer — that fires on first trade instead.
//
// Idempotent: if `Referral.refereeRewardKes` is already > 0, the bonus has
// already been credited on a prior deposit and we no-op.
//
// This helper opens its own transaction because it is called outside any
// payment-flow transaction (after the deposit credit has committed).

export async function creditRefereeBonusOnDeposit(
  refereeUserId: string,
  depositAmountKes: number
): Promise<{ credited: boolean; amountKes: number }> {
  const config = await prisma.referralConfig.findUnique({ where: { id: 'singleton' } });
  if (!config?.active) return { credited: false, amountKes: 0 };

  const minDeposit = Number(config.minDepositKes);
  if (depositAmountKes < minDeposit) return { credited: false, amountKes: 0 };

  const referral = await prisma.referral.findUnique({
    where: { refereeId: refereeUserId },
  });

  if (!referral || referral.status !== 'PENDING') {
    return { credited: false, amountKes: 0 };
  }

  // Idempotency: if the bonus was already credited on a prior deposit, do not
  // stack. We use the persisted refereeRewardKes on the Referral row as the
  // marker — it stays 0 until the first qualifying deposit credits the bonus.
  if (Number(referral.refereeRewardKes) > 0) {
    return { credited: false, amountKes: 0 };
  }

  const refereeBonus = Number(config.refereeMatchKes);
  if (refereeBonus <= 0) return { credited: false, amountKes: 0 };

  await prisma.$transaction(async (tx: any) => {
    // Credit referee bonus balance — promotional money, can stake but not withdraw directly
    await tx.user.update({
      where: { id: refereeUserId },
      data:  { bonusBalanceKes: { increment: refereeBonus } },
    });

    // Stamp the referral row with what the referee got, but DO NOT change status.
    // Status moves PENDING -> REWARDED in the trade endpoint when referrer is paid.
    await tx.referral.update({
      where: { refereeId: refereeUserId },
      data:  { refereeRewardKes: refereeBonus },
    });
  });

  console.log(`[Referral] ℹ️ Referee bonus credited: KES ${refereeBonus} to user ${refereeUserId}. Referrer reward pending first trade.`);
  return { credited: true, amountKes: refereeBonus };
}

// ─── Helper: pay referrer reward on referee's first trade ────────────────────
//
// Called from inside the trade-route Prisma transaction (so the wallet credit
// + status update + transaction log are all atomic with the order creation).
// MUST receive the tx client — do not call this with prisma.
//
// Caller is responsible for:
//   - Detecting that this is the referee's first trade (count of orders === 0)
//   - Passing the tx client from $transaction
//
// This helper:
//   - Reads ReferralConfig (active flag + referrer reward)
//   - Looks up the referee's Referral row
//   - If status is still PENDING, credits the referrer's real balance,
//     logs a REFERRAL_REWARD transaction, and transitions the row to REWARDED
//     (Option Y: skip QUALIFIED state)
//
// Returns the amount paid (0 if conditions not met) and the referrer's id so
// the caller can fire a fire-and-forget notification AFTER the transaction
// commits.

export async function payReferrerOnFirstTrade(
  tx: any,
  refereeUserId: string
): Promise<{ paid: number; referrerId: string | null }> {
  const config = await tx.referralConfig.findUnique({ where: { id: 'singleton' } });
  if (!config?.active) return { paid: 0, referrerId: null };

  const referral = await tx.referral.findUnique({
    where: { refereeId: refereeUserId },
  });

  if (!referral || referral.status !== 'PENDING') {
    return { paid: 0, referrerId: null };
  }

  const referrerReward = Number(config.referrerRewardKes);
  if (referrerReward <= 0) return { paid: 0, referrerId: referral.referrerId };

  // Credit referrer's real balance
  const referrerUpdated = await tx.user.update({
    where: { id: referral.referrerId },
    data:  { balanceKes: { increment: referrerReward } },
  });

  // Log referrer reward transaction
  await tx.transaction.create({
    data: {
      userId:      referral.referrerId,
      type:        'REFERRAL_REWARD',
      amountKes:   referrerReward,
      balAfter:    Number(referrerUpdated.balanceKes),
      status:      'SUCCESS',
      description: 'Referral reward — your referred user made their first forecast',
    },
  });

  // Move referral PENDING -> REWARDED in one transition (Option Y)
  await tx.referral.update({
    where: { refereeId: refereeUserId },
    data:  {
      status:            'REWARDED',
      referrerRewardKes: referrerReward,
      rewardPaidAt:      new Date(),
    },
  });

  return { paid: referrerReward, referrerId: referral.referrerId };
}

// ─── Helper: notify referrer (fire-and-forget) ───────────────────────────────
// Called by the trade route AFTER the transaction commits, with the values
// returned from payReferrerOnFirstTrade. Kept here so the notification copy
// lives next to the business logic that triggers it.

export async function notifyReferrerRewarded(
  referrerId: string,
  amountKes: number
): Promise<void> {
  try {
    await createNotification({
      userId:  referrerId,
      type:    'REFERRAL_REWARD_CREDITED',
      title:   '🎉 Referral reward earned!',
      message: `KES ${amountKes} credited to your wallet — your referral made their first forecast.`,
      link:    '/rada-friends.html',
    });
  } catch {
    /* notifications are best-effort */
  }
}
