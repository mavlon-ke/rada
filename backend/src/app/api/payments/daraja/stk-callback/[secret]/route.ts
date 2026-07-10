// src/app/api/payments/daraja/stk-callback/[secret]/route.ts
// Safaricom STK Push callback — confirms M-Pesa deposits and challenge stakes.
//
// SECURITY: Daraja does not sign callback requests with an HMAC header.
//   The DARAJA_CALLBACK_SECRET is embedded in the URL path. Only Safaricom
//   (who received this URL in the STK Push request) knows the full path.
//   Secret is validated on every request before any processing.
//
// IDEMPOTENCY: All credit operations are guarded by 'status: PENDING' checks.
//   A duplicate callback for the same CheckoutRequestID is silently ignored.
//
// AMOUNT VERIFICATION: Callback amount is cross-checked against the DB record.
//   Mismatches are logged and the transaction is left PENDING for manual review.

import { NextRequest, NextResponse }        from 'next/server';
import { prisma }                           from '@/lib/db/prisma';
import { withErrorHandling }                from '@/lib/security/route-guard';
import { sendWhatsAppNotification }         from '@/lib/whatsapp/whatsapp-notifications';
import { createNotification }               from '@/lib/notifications';
import { creditRefereeBonusOnDeposit }      from '@/lib/referrals/referral.service';
import { displayName }                      from '@/lib/user/display-name';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (
  req:     NextRequest,
  context: { params: { secret: string } }
) => {
  // ── Secret validation ───────────────────────────────────────────────────────
  const { secret } = context.params;
  if (!secret || secret !== process.env.DARAJA_CALLBACK_SECRET) {
    console.warn('[Daraja STK] Invalid callback secret — rejecting');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const callback = body?.Body?.stkCallback;
  if (!callback) {
    console.warn('[Daraja STK] Unexpected payload shape:', JSON.stringify(body).slice(0, 200));
    // Return 200 so Safaricom doesn't retry with the same malformed payload
    return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  const { CheckoutRequestID, ResultCode, ResultDesc } = callback;
  console.log(`[Daraja STK] Callback — CheckoutRequestID: ${CheckoutRequestID} ResultCode: ${ResultCode}`);

  // ── Payment failed or cancelled ─────────────────────────────────────────────
  if (ResultCode !== 0) {
    console.warn(`[Daraja STK] Non-zero result for ${CheckoutRequestID}: ${ResultDesc}`);
    await handleStkFailure(CheckoutRequestID, String(ResultDesc ?? 'Payment not completed'));
    return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  // ── Extract metadata from successful callback ───────────────────────────────
  // CallbackMetadata.Item is an array: [{ Name, Value }, ...]
  const items: Array<{ Name: string; Value?: any }> = callback.CallbackMetadata?.Item ?? [];
  const getItem = (name: string) => items.find(i => i.Name === name)?.Value;

  const callbackAmountKes = Number(getItem('Amount'));
  const mpesaReceipt      = String(getItem('MpesaReceiptNumber') ?? '');

  if (!callbackAmountKes) {
    console.error('[Daraja STK] Missing Amount in CallbackMetadata for', CheckoutRequestID);
    return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  // ── Look up pending transaction by CheckoutRequestID ───────────────────────
  const transaction = await prisma.transaction.findFirst({
    where:   { mpesaRef: CheckoutRequestID, status: 'PENDING' },
    include: { user: true },
  });

  if (!transaction) {
    console.warn('[Daraja STK] No PENDING transaction found for CheckoutRequestID:', CheckoutRequestID);
    return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  // ── Amount verification ────────────────────────────────────────────────────
  // Cross-check callback amount against what we recorded in the DB.
  // This defends against any manipulation of the callback payload.
  const expectedKes = Number(transaction.amountKes);
  if (callbackAmountKes !== expectedKes) {
    console.error(
      `[Daraja STK] AMOUNT MISMATCH on ${CheckoutRequestID}: ` +
      `expected KES ${expectedKes}, callback KES ${callbackAmountKes}. ` +
      `Transaction left PENDING for manual review.`
    );
    return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  // ── Route by transaction type ──────────────────────────────────────────────
  if (transaction.type === 'DEPOSIT') {
    await handleDepositSuccess(transaction, mpesaReceipt);
  } else if (transaction.type === 'CHALLENGE_STAKE') {
    await handleChallengeStakeSuccess(transaction, mpesaReceipt);
  } else {
    console.warn('[Daraja STK] Unhandled transaction type:', transaction.type, 'for', CheckoutRequestID);
  }

  // Always return 200 — Safaricom will retry on non-2xx
  return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// ─── Deposit success ──────────────────────────────────────────────────────────

async function handleDepositSuccess(transaction: any, mpesaReceipt: string) {
  const amountKes = Number(transaction.amountKes);

  await prisma.$transaction(async (tx: any) => {
    const freshUser  = await tx.user.findUnique({ where: { id: transaction.userId } });
    if (!freshUser) {
      // User was deleted after initiating the deposit — log and abort cleanly.
      // Wallet cannot be credited. Transaction stays PENDING for manual admin review.
      console.error(`[Daraja STK] Deposit for deleted user ${transaction.userId} — tx ${transaction.id} left PENDING`);
      return;
    }
    const newBalance = Number(freshUser.balanceKes) + amountKes;

    await tx.user.update({
      where: { id: transaction.userId },
      data:  { balanceKes: { increment: amountKes } },
    });

    await tx.transaction.update({
      where: { id: transaction.id },
      data:  {
        status:      'SUCCESS',
        balAfter:    newBalance,
        description: `M-Pesa deposit of KES ${amountKes.toLocaleString()} confirmed. Receipt: ${mpesaReceipt}`,
      },
    });

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

  // WhatsApp mirror — fires after transaction commits
  void sendWhatsAppNotification(
    transaction.userId,
    'DEPOSIT_CONFIRMED',
    [amountKes.toLocaleString()]
  );

  // Referral programme — delegate to service module
  await creditRefereeBonusOnDeposit(transaction.userId, amountKes);

  console.log(`[Daraja STK] ✅ Deposit confirmed: KES ${amountKes} for user ${transaction.userId}`);
}

// ─── Challenge stake success ──────────────────────────────────────────────────

async function handleChallengeStakeSuccess(transaction: any, mpesaReceipt: string) {
  const amountKes = Number(transaction.amountKes);

  // Mark the M-Pesa payment transaction as SUCCESS
  await prisma.transaction.update({
    where: { id: transaction.id },
    data:  {
      status:      'SUCCESS',
      description: `Challenge M-Pesa payment confirmed: KES ${amountKes}. Receipt: ${mpesaReceipt}`,
    },
  });

  if (!transaction.challengeId) {
    console.warn('[Daraja STK] Challenge stake missing challengeId:', transaction.id);
    return;
  }

  // Load the first challenge (and batch siblings if batchId is set)
  const firstChallenge = await prisma.marketChallenge.findUnique({
    where:   { id: transaction.challengeId },
    include: {
      userA:   { select: { id: true, name: true, phone: true } },
      userB:   { select: { id: true, name: true, phone: true } },
      referee: { select: { id: true, name: true, phone: true } },
    },
  });
  if (!firstChallenge) return;

  const toActivate = firstChallenge.batchId
    ? await prisma.marketChallenge.findMany({
        where:   { batchId: firstChallenge.batchId, status: 'PENDING_PAYMENT' },
        include: {
          userA:   { select: { id: true, name: true, phone: true } },
          userB:   { select: { id: true, name: true, phone: true } },
          referee: { select: { id: true, name: true, phone: true } },
        },
      })
    : [firstChallenge];

  // Notify creator: payment confirmed
  const challengeWord = toActivate.length > 1 ? `${toActivate.length} challenges` : 'challenge';
  void createNotification({
    userId:  transaction.userId,
    type:    'DEPOSIT_CONFIRMED',
    title:   'Challenge payment confirmed',
    message: `Your KES ${amountKes.toLocaleString()} M-Pesa payment confirmed. ${challengeWord} now active.`,
    link:    '/rada-friends.html',
  });

  // Activate each challenge in the batch
  for (const ch of toActivate) {
    const mpesaForThis = Math.max(0, Number(ch.stakePerPerson) - Number(ch.totalPool));
    const newStatus    = ch.status === 'PENDING_PAYMENT' ? 'PENDING_JOIN' : ch.status;

    await prisma.marketChallenge.update({
      where: { id: ch.id },
      data:  {
        totalPool: { increment: mpesaForThis },
        status:    newStatus,
      },
    });

    // Notify challenger B
    if (ch.userBId && ch.userA) {
      void createNotification({
        userId:  ch.userBId,
        type:    'CHALLENGE_OPPONENT_STAKED',
        title:   "You've been challenged!",
        message: `${displayName(ch.userA.name, ch.userA.phone)} challenged you: "${ch.question.slice(0, 70)}". Stake: KES ${Number(ch.stakePerPerson).toLocaleString()}. Code: ${ch.accessCode}`,
        link:    `/join/${ch.accessCode}`,
        whatsapp: {
          template:   'CHALLENGE_OPPONENT_STAKED',
          parameters: [displayName(ch.userA.name, ch.userA.phone), Number(ch.stakePerPerson).toLocaleString()],
        },
      });
    }

    // Notify referee
    if (ch.refereeId && ch.userA) {
      void createNotification({
        userId:  ch.refereeId,
        type:    'REFEREE_NOMINATED',
        title:   "You've been nominated as referee",
        message: `${displayName(ch.userA.name, ch.userA.phone)} nominated you to referee a challenge. Code: ${ch.accessCode}`,
        link:    '/rada-friends.html',
        whatsapp: {
          template:   'REFEREE_NOMINATED',
          parameters: [displayName(ch.userA.name, ch.userA.phone)],
        },
      });
    }

    console.log(`[Daraja STK] Challenge activated: ${ch.id} (KES ${mpesaForThis} M-Pesa)`);
  }
}

// ─── STK failure / cancellation ───────────────────────────────────────────────

async function handleStkFailure(checkoutRequestId: string, reason: string) {
  const transaction = await prisma.transaction.findFirst({
    where: { mpesaRef: checkoutRequestId, status: 'PENDING' },
  });

  if (!transaction) {
    // Already processed or unknown — nothing to do
    return;
  }

  await prisma.transaction.update({
    where: { id: transaction.id },
    data:  {
      status:      'FAILED',
      description: `M-Pesa payment not completed: ${reason.slice(0, 100)}`,
    },
  });

  // For challenge stakes: cancel the challenge and refund any wallet portion
  if (transaction.type === 'CHALLENGE_STAKE' && transaction.challengeId) {
    const challenge = await prisma.marketChallenge.findUnique({
      where: { id: transaction.challengeId },
    });

    if (challenge) {
      // Cancel — single challenge or entire batch
      if (challenge.batchId) {
        await prisma.marketChallenge.updateMany({
          where: { batchId: challenge.batchId, status: 'PENDING_PAYMENT' },
          data:  { status: 'CANCELLED' },
        });
      } else {
        await prisma.marketChallenge.update({
          where: { id: transaction.challengeId },
          data:  { status: 'CANCELLED' },
        });
      }

      // Refund wallet portion: challenge.totalPool holds what was deducted from
      // the wallet before the STK push was sent (M-Pesa shortfall was not paid).
      const walletRefund = Number(challenge.totalPool);
      if (walletRefund > 0) {
        await prisma.user.update({
          where: { id: transaction.userId },
          data:  { balanceKes: { increment: walletRefund } },
        });
      }
    }

    void createNotification({
      userId:  transaction.userId,
      type:    'DEPOSIT_CONFIRMED',
      title:   '⚠️ M-Pesa payment not completed',
      message: 'Your challenge payment was not completed. Any amount deducted from your wallet has been refunded.',
      link:    '/rada-friends.html',
    });
  }

  console.log(`[Daraja STK] ❌ Payment failed for ${checkoutRequestId}: ${reason}`);
}
