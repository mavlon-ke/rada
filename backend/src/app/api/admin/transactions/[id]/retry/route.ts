// src/app/api/admin/transactions/[id]/retry/route.ts
// POST — retry a failed PAYOUT transaction via Paystack

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';
import {
  createTransferRecipient,
  initiateTransfer,
  normalisePhone as formatPhone,
  generateReference,
} from '@/lib/paystack/paystack.service';

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

  const phone      = txn.phone || txn.user?.phone;
  const amountKes  = Number(txn.amountKes);

  if (!phone) {
    return NextResponse.json({ error: 'No phone number on transaction to send payout' }, { status: 400 });
  }

  try {
    const reference = generateReference('TRF');

    const recipient = await createTransferRecipient({
      name:     txn.user?.name || phone,
      phone:    formatPhone(phone),
      bankCode: 'MPesa',
    });

    const transfer = await initiateTransfer({
      amountKes,
      recipientCode: recipient.recipient_code,
      reference,
      reason: `Retry payout — original txn ${txn.id}`,
    });

    // Update original transaction to SUCCESS
    await prisma.transaction.update({
      where: { id: params.id },
      data: {
        status:   'SUCCESS',
        mpesaRef: transfer.reference || reference,
      },
    });

    await logAdminAction(
      admin.id, 'PAYOUT_RETRY_SUCCESS', params.id,
      { phone, amountKes, reference },
      req
    );

    return NextResponse.json({
      success:   true,
      reference: transfer.reference || reference,
      message:   `KES ${amountKes} retry payout initiated to ${phone}`,
    });

  } catch (err: any) {
    await logAdminAction(
      admin.id, 'PAYOUT_RETRY_FAILED', params.id,
      { phone, amountKes, error: err.message },
      req
    );

    return NextResponse.json(
      { error: 'Retry failed: ' + (err.message || 'Paystack error') },
      { status: 500 }
    );
  }
}
