// src/app/api/payments/paystack/webhook/route.ts
// Paystack webhook — confirms deposits and withdrawals
// SECURITY: Signature verified before any processing

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { verifyWebhookSignature, verifyTransaction } from '@/lib/paystack/paystack.service';
import { withErrorHandling } from '@/lib/security/route-guard';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (req: NextRequest) => {
  const rawBody  = await req.text();
  const signature = req.headers.get('x-paystack-signature') ?? '';

  // SECURITY: Always verify webhook signature first
  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn('[Paystack Webhook] Invalid signature — rejecting');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const eventType = event.event;
  const data      = event.data;

  console.log('[Paystack Webhook] Event:', eventType, 'Reference:', data?.reference);

  // ── Handle charge success (M-Pesa STK Push or Card deposit) ──────────────
  if (eventType === 'charge.success') {
    await handleChargeSuccess(data);
  }

  // ── Handle transfer success (Withdrawal) ─────────────────────────────────
  if (eventType === 'transfer.success') {
    await handleTransferSuccess(data);
  }

  // ── Handle transfer failure (Withdrawal failed) ───────────────────────────
  if (eventType === 'transfer.failed' || eventType === 'transfer.reversed') {
    await handleTransferFailed(data);
  }

  // Always return 200 to Paystack — even if we didn't handle the event
  return NextResponse.json({ received: true }, { status: 200 });
});

// ─── Charge success handler ───────────────────────────────────────────────────

async function handleChargeSuccess(data: any) {
  const reference = data.reference;
  const amountKes = Math.round(data.amount / 100); // Convert from kobo to KES

  // Find the pending transaction by reference
  const transaction = await prisma.transaction.findFirst({
    where:  { mpesaRef: reference, status: 'PENDING', type: 'DEPOSIT' },
    include: { user: true },
  });

  if (!transaction) {
    console.warn('[Paystack Webhook] No pending deposit found for reference:', reference);
    return;
  }

  // Idempotency check — don't process twice
  if (transaction.status === 'SUCCESS') {
    console.log('[Paystack Webhook] Already processed:', reference);
    return;
  }

  // Verify with Paystack API (double-check)
  const verified = await verifyTransaction(reference);
  if (verified.status !== 'success') {
    console.warn('[Paystack Webhook] Verification failed for:', reference);
    return;
  }

  // Credit user balance atomically
  await prisma.$transaction(async (tx: any) => {
    const freshUser = await tx.user.findUnique({ where: { id: transaction.userId } });
    const newBalance = Number(freshUser.balanceKes) + amountKes;

    await tx.user.update({
      where: { id: transaction.userId },
      data:  { balanceKes: { increment: amountKes } },
    });

    await tx.transaction.update({
      where: { id: transaction.id },
      data:  {
        status:   'SUCCESS',
        balAfter: newBalance,
        description: `M-Pesa deposit of KES ${amountKes} confirmed`,
      },
    });

    // Create in-app notification
    await tx.notification.create({
      data: {
        userId:  transaction.userId,
        type:    'DEPOSIT_CONFIRMED',
        title:   '✅ Deposit confirmed',
        message: `KES ${amountKes.toLocaleString()} has been added to your CheckRada wallet.`,
        link:    '/rada-dashboard.html',
      },
    });
  });

  // Check if this qualifies a pending referral
  await qualifyReferral(transaction.userId, amountKes);

  console.log(`[Paystack Webhook] ✅ Deposit confirmed: KES ${amountKes} for user ${transaction.userId}`);
}

// ─── Transfer success handler ─────────────────────────────────────────────────

async function handleTransferSuccess(data: any) {
  const reference = data.reference;

  const transaction = await prisma.transaction.findFirst({
    where: { mpesaRef: reference, status: 'PENDING', type: 'WITHDRAWAL' },
  });

  if (!transaction) return;

  await prisma.transaction.update({
    where: { id: transaction.id },
    data:  { status: 'SUCCESS' },
  });

  await prisma.notification.create({
    data: {
      userId:  transaction.userId,
      type:    'WITHDRAWAL_PROCESSED',
      title:   '✅ Withdrawal processed',
      message: `Your withdrawal of KES ${Math.abs(Number(transaction.amountKes)).toLocaleString()} has been sent to your M-Pesa.`,
      link:    '/rada-portfolio.html',
    },
  });

  console.log(`[Paystack Webhook] ✅ Withdrawal confirmed for transaction ${transaction.id}`);
}

// ─── Transfer failed handler ──────────────────────────────────────────────────

async function handleTransferFailed(data: any) {
  const reference = data.reference;

  const transaction = await prisma.transaction.findFirst({
    where: { mpesaRef: reference, status: 'PENDING', type: 'WITHDRAWAL' },
    include: { user: true },
  });

  if (!transaction) return;

  // FIX: refund exactly what was deducted from wallet (amountKes already = gross)
  const totalRefund = Math.abs(Number(transaction.amountKes));

  await prisma.$transaction(async (tx: any) => {
    const freshUser = await tx.user.findUnique({ where: { id: transaction.userId } });
    const newBalance = Number(freshUser.balanceKes) + totalRefund;

    await tx.user.update({
      where: { id: transaction.userId },
      data:  { balanceKes: { increment: totalRefund } },
    });

    await tx.transaction.update({
      where: { id: transaction.id },
      data:  { status: 'FAILED', balAfter: newBalance },
    });

    await tx.notification.create({
      data: {
        userId:  transaction.userId,
        type:    'WITHDRAWAL_PROCESSED',
        title:   '⚠️ Withdrawal failed',
        message: `Your withdrawal could not be processed. KES ${totalRefund.toLocaleString()} has been refunded to your wallet.`,
        link:    '/rada-portfolio.html',
      },
    });
  });

  console.log(`[Paystack Webhook] ❌ Withdrawal failed — refunded KES ${totalRefund} to user ${transaction.userId}`);
}

// ─── Referral qualification ───────────────────────────────────────────────────

async function qualifyReferral(userId: string, amountKes: number) {
  const config = await prisma.referralConfig.findUnique({ where: { id: 'singleton' } });
  if (!config?.active) return;

  const minDeposit = Number(config.minDepositKes);
  if (amountKes < minDeposit) return;

  const referral = await prisma.referral.findUnique({
    where:  { refereeId: userId },
  });

  if (!referral || referral.status !== 'PENDING') return;

  const referrerReward = Number(config.referrerRewardKes);
  const refereeBonus   = Number(config.refereeMatchKes);

  await prisma.$transaction(async (tx: any) => {
    // Credit referrer
    await tx.user.update({
      where: { id: referral.referrerId },
      data:  { balanceKes: { increment: referrerReward } },
    });

    // Credit referee bonus balance (locked until first trade)
    await tx.user.update({
      where: { id: userId },
      data:  { bonusBalanceKes: { increment: refereeBonus } },
    });

    // Mark referral as qualified
    await tx.referral.update({
      where: { refereeId: userId },
      data:  {
        status:           'QUALIFIED',
        referrerRewardKes: referrerReward,
        refereeRewardKes:  refereeBonus,
        rewardPaidAt:     new Date(),
      },
    });

    // Notify referrer
    await tx.notification.create({
      data: {
        userId:  referral.referrerId,
        type:    'REFERRAL_REWARD_CREDITED',
        title:   '🎉 Referral reward earned!',
        message: `KES ${referrerReward} has been credited to your wallet. Your referral made their first deposit!`,
        link:    '/rada-friends.html',
      },
    });
  });

  console.log(`[Referral] ✅ Qualified: referrer ${referral.referrerId} earned KES ${referrerReward}`);
}
