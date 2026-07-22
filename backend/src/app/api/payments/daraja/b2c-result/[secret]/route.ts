// src/app/api/payments/daraja/b2c-result/[secret]/route.ts
// Safaricom B2C result callback — confirms or fails M-Pesa withdrawal payouts.
//
// Safaricom sends this for both success (ResultCode 0) and failure (any other code).
// Lookup key: Result.OriginatorConversationID = transaction.mpesaRef (set at initiation).
// On failure: wallet is refunded atomically and user is notified.
//
// C-5 FIX: Status-guarded updateMany prevents duplicate callbacks from
// double-refunding the wallet. Only ONE callback wins the race per transaction.

import { NextRequest, NextResponse } from 'next/server';
import { prisma }                    from '@/lib/db/prisma';
import { withErrorHandling }         from '@/lib/security/route-guard';
import { createNotification }        from '@/lib/notifications';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (
  req:     NextRequest,
  context: { params: { secret: string } }
) => {
  const { secret } = context.params;
  if (!secret || secret !== process.env.DARAJA_CALLBACK_SECRET) {
    console.warn('[Daraja B2C] Invalid callback secret');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const result = body?.Result;
  if (!result) {
    console.warn('[Daraja B2C] Unexpected payload:', JSON.stringify(body).slice(0, 200));
    return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  const { OriginatorConversationID, ResultCode, ResultDesc } = result;
  console.log(`[Daraja B2C] Result — OriginatorConvID: ${OriginatorConversationID} ResultCode: ${ResultCode}`);

  // Look up the transaction — still PENDING at this point
  const transaction = await prisma.transaction.findFirst({
    where: { mpesaRef: OriginatorConversationID, status: 'PENDING' },
  });

  if (!transaction) {
    console.warn('[Daraja B2C] No PENDING transaction for OriginatorConversationID:', OriginatorConversationID);
    return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  if (ResultCode === 0) {
    // ── Success: C-5 FIX — atomic status flip before marking complete ────────
    const params: Array<{ Key: string; Value?: any }> =
      result.ResultParameters?.ResultParameter ?? [];
    const getParam = (key: string) => params.find((p: any) => p.Key === key)?.Value;
    const receipt  = String(getParam('TransactionReceipt') ?? '');

    const claimed = await prisma.transaction.updateMany({
      where: { id: transaction.id, status: 'PENDING' },
      data:  {
        status:      'SUCCESS',
        description: `Withdrawal of KES ${Math.abs(Number(transaction.amountKes)).toLocaleString()} sent to M-Pesa. Receipt: ${receipt}`,
      },
    });

    if (claimed.count === 0) {
      console.warn('[Daraja B2C] C-5: Duplicate success callback ignored for:', transaction.id);
      return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    void createNotification({
      userId:  transaction.userId,
      type:    'WITHDRAWAL_PROCESSED',
      title:   '✅ Withdrawal sent',
      message: `KES ${Math.abs(Number(transaction.amountKes)).toLocaleString()} has been sent to your M-Pesa${receipt ? `. Receipt: ${receipt}` : ''}.`,
      link:    '/rada-dashboard.html',
    });

    console.log(`[Daraja B2C] ✅ Withdrawal confirmed for transaction ${transaction.id}`);

  } else {
    // ── Failure: C-5 FIX — atomic claim before refunding wallet ─────────────
    // The updateMany + wallet increment are in one $transaction so if the
    // status flip gets count=0 (duplicate), the refund is also skipped.
    const amountToRefund = Math.abs(Number(transaction.amountKes));

    const refunded = await prisma.$transaction(async (tx: any) => {
      const claimed = await tx.transaction.updateMany({
        where: { id: transaction.id, status: 'PENDING' },
        data:  {
          status:      'FAILED',
          description: `Withdrawal failed: ${String(ResultDesc ?? 'Unknown error').slice(0, 100)}. KES ${amountToRefund.toLocaleString()} refunded to wallet.`,
        },
      });

      if (claimed.count === 0) {
        // Duplicate failure callback — do NOT refund again
        return false;
      }

      await tx.user.update({
        where: { id: transaction.userId },
        data:  { balanceKes: { increment: amountToRefund } },
      });

      return true;
    });

    if (!refunded) {
      console.warn('[Daraja B2C] C-5: Duplicate failure callback ignored for:', transaction.id);
      return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    void createNotification({
      userId:  transaction.userId,
      type:    'WITHDRAWAL_PROCESSED',
      title:   '⚠️ Withdrawal failed',
      message: `Your withdrawal of KES ${amountToRefund.toLocaleString()} could not be completed. Your wallet has been refunded.`,
      link:    '/rada-dashboard.html',
    });

    console.error(`[Daraja B2C] ❌ Withdrawal failed for ${OriginatorConversationID}: ${ResultDesc}`);
  }

  return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});
