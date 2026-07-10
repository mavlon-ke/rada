// src/app/api/payments/daraja/b2c-result/[secret]/route.ts
// Safaricom B2C result callback — confirms or fails M-Pesa withdrawal payouts.
//
// Safaricom sends this for both success (ResultCode 0) and failure (any other code).
// Lookup key: Result.OriginatorConversationID = transaction.mpesaRef (set at initiation).
// On failure: wallet is refunded atomically and user is notified.

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

  const transaction = await prisma.transaction.findFirst({
    where: { mpesaRef: OriginatorConversationID, status: 'PENDING' },
  });

  if (!transaction) {
    console.warn('[Daraja B2C] No PENDING transaction for OriginatorConversationID:', OriginatorConversationID);
    return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  if (ResultCode === 0) {
    // ── Success: mark withdrawal complete ──────────────────────────────────
    const params: Array<{ Key: string; Value?: any }> =
      result.ResultParameters?.ResultParameter ?? [];
    const getParam = (key: string) => params.find((p: any) => p.Key === key)?.Value;
    const receipt  = String(getParam('TransactionReceipt') ?? '');

    await prisma.transaction.update({
      where: { id: transaction.id },
      data:  {
        status:      'SUCCESS',
        description: `Withdrawal of KES ${Math.abs(Number(transaction.amountKes)).toLocaleString()} sent to M-Pesa. Receipt: ${receipt}`,
      },
    });

    void createNotification({
      userId:  transaction.userId,
      type:    'WITHDRAWAL_PROCESSED',
      title:   '✅ Withdrawal sent',
      message: `KES ${Math.abs(Number(transaction.amountKes)).toLocaleString()} has been sent to your M-Pesa${receipt ? `. Receipt: ${receipt}` : ''}.`,
      link:    '/rada-dashboard.html',
    });

    console.log(`[Daraja B2C] ✅ Withdrawal confirmed for transaction ${transaction.id}`);

  } else {
    // ── Failure: refund wallet ─────────────────────────────────────────────
    const amountToRefund = Math.abs(Number(transaction.amountKes));

    await prisma.$transaction(async (tx: any) => {
      await tx.user.update({
        where: { id: transaction.userId },
        data:  { balanceKes: { increment: amountToRefund } },
      });
      await tx.transaction.update({
        where: { id: transaction.id },
        data:  {
          status:      'FAILED',
          description: `Withdrawal failed: ${String(ResultDesc ?? 'Unknown error').slice(0, 100)}. KES ${amountToRefund.toLocaleString()} refunded to wallet.`,
        },
      });
    });

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
