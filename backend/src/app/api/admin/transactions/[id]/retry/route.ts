// src/app/api/admin/transactions/[id]/retry/route.ts
// POST — retry a failed PAYOUT or CHALLENGE_PAYOUT transaction via Daraja B2C.

import { NextRequest, NextResponse } from 'next/server';
import { prisma }                    from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';
import { b2cTransfer, generateDarajaRef, darajaPhone }     from '@/lib/payments/payment.service';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const txn = await prisma.transaction.findUnique({
    where:   { id: params.id },
    include: { user: true },
  });

  if (!txn) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
  }
  if (txn.type !== 'PAYOUT' && txn.type !== 'CHALLENGE_PAYOUT') {
    return NextResponse.json({ error: 'Only PAYOUT transactions can be retried' }, { status: 400 });
  }
  if (txn.status === 'SUCCESS') {
    return NextResponse.json({ error: 'Transaction already succeeded' }, { status: 400 });
  }

  const rawPhone  = txn.phone || txn.user?.phone;
  const amountKes = Math.abs(Number(txn.amountKes));

  if (!rawPhone) {
    return NextResponse.json({ error: 'No phone number on transaction to send payout' }, { status: 400 });
  }

  const accountRef = generateDarajaRef('CRW');
  const phone      = darajaPhone(rawPhone);

  try {
    const b2cResult = await b2cTransfer({
      amountKes,
      phone,
      reference: accountRef,
      occasion:  `Retry payout — original txn ${txn.id}`,
    });

    await prisma.transaction.update({
      where: { id: params.id },
      data:  {
        status:   'SUCCESS',
        mpesaRef: b2cResult.OriginatorConversationID,
      },
    });

    await logAdminAction(
      admin.id, 'PAYOUT_RETRY_SUCCESS', params.id,
      { phone, amountKes, originatorConvId: b2cResult.OriginatorConversationID },
      req
    );

    return NextResponse.json({
      success: true,
      message: `KES ${amountKes} retry payout initiated to ${phone}`,
    });

  } catch (err: any) {
    await logAdminAction(
      admin.id, 'PAYOUT_RETRY_FAILED', params.id,
      { phone, amountKes, error: err.message },
      req
    );

    return NextResponse.json(
      { error: 'Retry failed: ' + (err.message || 'Daraja error') },
      { status: 500 }
    );
  }
}
