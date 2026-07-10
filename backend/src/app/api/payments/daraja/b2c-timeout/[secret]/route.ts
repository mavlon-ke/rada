// src/app/api/payments/daraja/b2c-timeout/[secret]/route.ts
// Safaricom B2C queue timeout callback.
// Fires when a B2C request stays in Safaricom's queue beyond the allowed window
// without being processed. Treat as failure — refund the wallet immediately.

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
    console.warn('[Daraja B2C Timeout] Invalid callback secret');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const result = body?.Result;
  const origConvId = result?.OriginatorConversationID;

  console.warn(`[Daraja B2C Timeout] Queue timeout for OriginatorConversationID: ${origConvId}`);

  if (!origConvId) {
    return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  const transaction = await prisma.transaction.findFirst({
    where: { mpesaRef: origConvId, status: 'PENDING' },
  });

  if (!transaction) {
    return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

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
        description: `Withdrawal timed out in M-Pesa queue. KES ${amountToRefund.toLocaleString()} refunded to wallet.`,
      },
    });
  });

  void createNotification({
    userId:  transaction.userId,
    type:    'WITHDRAWAL_PROCESSED',
    title:   '⚠️ Withdrawal timed out',
    message: `Your withdrawal of KES ${amountToRefund.toLocaleString()} could not be processed in time. Your wallet has been refunded. Please try again.`,
    link:    '/rada-dashboard.html',
  });

  console.warn(`[Daraja B2C Timeout] Refunded KES ${amountToRefund} for transaction ${transaction.id}`);
  return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});
