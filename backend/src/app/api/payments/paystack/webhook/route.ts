// src/app/api/payments/paystack/webhook/route.ts
// Paystack webhook — confirms deposits and withdrawals.
// SECURITY: Signature verified before any processing.
//
// Single responsibility: payment-flow infrastructure (verify, credit deposit,
// process transfer success/failure). Business-logic side-effects (referral
// programme, etc.) are delegated to dedicated service modules so this file
// can be reused unchanged when a second payment provider is added.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { verifyWebhookSignature, verifyTransaction } from '@/lib/paystack/paystack.service';
import { withErrorHandling } from '@/lib/security/route-guard';
import { creditRefereeBonusOnDeposit } from '@/lib/referrals/referral.service';
import { sendWhatsAppNotification } from '@/lib/whatsapp/whatsapp-notifications';
import { createNotification } from '@/lib/notifications';
import { displayName }        from '@/lib/user/display-name';

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

  // Deposit or challenge stake?
  const transaction = await prisma.transaction.findFirst({
    where:  { mpesaRef: reference, status: 'PENDING', type: 'DEPOSIT' },
    include: { user: true },
  });

  if (!transaction) {
    await handleChallengeStakeSuccess(data);
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

  // SECURITY: cross-check amounts in KOBO (smallest unit — integer math,
  // no rounding errors). The webhook payload, Paystack API verification,
  // and our own DB record must all agree before we credit the user.
  // Defends against forged/replayed webhooks and Paystack-side amount bugs.
  const expectedKobo = Math.round(Number(transaction.amountKes) * 100);
  const webhookKobo  = data.amount;
  const verifiedKobo = verified.amount;

  if (webhookKobo !== expectedKobo || verifiedKobo !== expectedKobo) {
    console.error(
      `[Paystack Webhook] AMOUNT MISMATCH on ${reference}: ` +
      `expected=${expectedKobo}kobo, webhook=${webhookKobo}kobo, verified=${verifiedKobo}kobo. ` +
      `Refusing to credit. Transaction left PENDING for manual review.`
    );
    return;
  }

  // From here on, use the amount we recorded in our own DB — never the payload.
  const amountKes = Number(transaction.amountKes);

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

// Diagnostic — confirm we reach this point
  console.log('[Webhook DIAG] About to call sendWhatsAppNotification for user ${transaction.userId}');

  // Fire-and-forget WhatsApp mirror of the in-app notification just created.
  // Placed AFTER the prisma.$transaction commits — if transaction rolled
  // back, no WhatsApp send fires. Library is fail-closed (never throws).
  void sendWhatsAppNotification(
    transaction.userId,
    'DEPOSIT_CONFIRMED',
    [amountKes.toLocaleString()],
  );

  // Delegate referral business logic to the service module — keeps this
  // webhook focused on payment infrastructure only.
  await creditRefereeBonusOnDeposit(transaction.userId, amountKes);

  console.log(`[Paystack Webhook] ✅ Deposit confirmed: KES ${amountKes} for user ${transaction.userId}`);
}

// ─── Challenge stake confirmation (single + batch) ────────────────────────────
// Handles both single-challenge and batch M-Pesa payments.
// For batch: the transaction links to the first challenge; batchId identifies the rest.
// Uses stakePerPerson - totalPool to determine M-Pesa portion per challenge.

async function handleChallengeStakeSuccess(data: any) {
  const reference = data.reference;
  const pendingTx = await prisma.transaction.findFirst({
    where:   { mpesaRef: reference, status: 'PENDING', type: 'CHALLENGE_STAKE' },
    include: { user: true },
  });
  if (!pendingTx || !pendingTx.challengeId) {
    console.warn('[Webhook] No pending challenge stake for:', reference);
    return;
  }
  if (pendingTx.status === 'SUCCESS') return;

  const verified = await verifyTransaction(reference);
  if (verified.status !== 'success') return;

  const expectedKobo = Math.round(Number(pendingTx.amountKes) * 100);
  if (data.amount !== expectedKobo || verified.amount !== expectedKobo) {
    console.error('[Webhook] AMOUNT MISMATCH on challenge stake:', reference);
    return;
  }

  await prisma.transaction.update({
    where: { id: pendingTx.id },
    data:  { status: 'SUCCESS', description: 'Challenge M-Pesa payment confirmed: KES ' + Number(pendingTx.amountKes) },
  });

  const firstChallenge = await prisma.marketChallenge.findUnique({
    where:   { id: pendingTx.challengeId },
    include: {
      userA:   { select: { id: true, name: true, phone: true } },
      userB:   { select: { id: true, name: true, phone: true } },
      referee: { select: { id: true, name: true, phone: true } },
    },
  });
  if (!firstChallenge) return;

  const toActivate = firstChallenge.batchId
    ? await prisma.marketChallenge.findMany({
        where: { batchId: firstChallenge.batchId, status: 'PENDING_PAYMENT' },
        include: {
          userA:   { select: { id: true, name: true, phone: true } },
          userB:   { select: { id: true, name: true, phone: true } },
          referee: { select: { id: true, name: true, phone: true } },
        },
      })
    : [firstChallenge];

  if (pendingTx.user) {
    const challengeWord = toActivate.length > 1 ? toActivate.length + ' challenges' : 'challenge';
    void createNotification({
      userId:  pendingTx.user.id,
      type:    'DEPOSIT_CONFIRMED',
      title:   'Challenge payment confirmed',
      message: 'Your KES ' + Number(pendingTx.amountKes).toLocaleString() + ' M-Pesa payment confirmed. ' + challengeWord + ' now active.',
      link:    '/rada-friends.html',
    });
  }

  for (const ch of toActivate) {
    const mpesaForThis = Math.max(0, Number(ch.stakePerPerson) - Number(ch.totalPool));
    await prisma.marketChallenge.update({
      where: { id: ch.id },
      data:  { totalPool: { increment: mpesaForThis }, status: 'PENDING_JOIN' },
    });

    if (ch.userBId && ch.userA) {
      void createNotification({
        userId:  ch.userBId,
        type:    'CHALLENGE_OPPONENT_STAKED',
        title:   "You've been challenged!",
        message: displayName(ch.userA.name, ch.userA.phone) + ' challenged you: "' + ch.question.slice(0, 70) + '". Stake: KES ' + Number(ch.stakePerPerson).toLocaleString() + '. Code: ' + ch.accessCode,
        link:    '/join/' + ch.accessCode,
        whatsapp: {
          template:   'CHALLENGE_OPPONENT_STAKED',
          parameters: [displayName(ch.userA.name, ch.userA.phone), String(Number(ch.stakePerPerson).toLocaleString())],
        },
      });
    }
    if (ch.refereeId && ch.userA) {
      void createNotification({
        userId:  ch.refereeId,
        type:    'REFEREE_NOMINATED',
        title:   "You've been nominated as referee",
        message: displayName(ch.userA.name, ch.userA.phone) + ' nominated you to referee a challenge. Code: ' + ch.accessCode,
        link:    '/rada-friends.html',
        whatsapp: {
          template:   'REFEREE_NOMINATED',
          parameters: [displayName(ch.userA.name, ch.userA.phone)],
        },
      });
    }
    console.log('[Webhook] Challenge activated: ' + ch.id + ' (KES ' + mpesaForThis + ' M-Pesa)');
  }
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


  // Fire-and-forget WhatsApp mirror.
  void sendWhatsAppNotification(
    transaction.userId,
    'WITHDRAWAL_PROCESSED',
    [Math.abs(Number(transaction.amountKes)).toLocaleString()],
  );

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
