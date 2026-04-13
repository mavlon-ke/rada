// src/app/api/payments/withdraw/route.ts
// Withdrawal via Paystack Transfer (M-Pesa B2C)
// Replaces: Safaricom Daraja B2C integration

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/security/route-guard';
import {
  createTransferRecipient,
  initiateTransfer,
  generateReference,
  normalisePhone,
} from '@/lib/paystack/paystack.service';

export const dynamic = 'force-dynamic';

const WithdrawSchema = z.object({
  amountKes: z.number().min(50).max(70000),
  phone:     z.string().min(9).max(15),
});

const WITHDRAWAL_FEE_PERCENT = 0.01; // 1% withdrawal fee

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json();
  const parsed = WithdrawSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { amountKes, phone } = parsed.data;
  const fee             = Math.ceil(amountKes * WITHDRAWAL_FEE_PERCENT);
  const totalDeduction  = amountKes + fee;
  const formattedPhone  = normalisePhone(phone);
  const reference       = generateReference('WIT');

  // Atomic balance check + deduct
  const result = await prisma.$transaction(async (tx: any) => {
    const freshUser = await tx.user.findUnique({ where: { id: user.id } });

    if (!freshUser || Number(freshUser.balanceKes) < totalDeduction) {
      throw new Error(
        `Insufficient balance. Need KES ${totalDeduction} (incl. KES ${fee} fee).`
      );
    }

    await tx.user.update({
      where: { id: user.id },
      data:  { balanceKes: { decrement: totalDeduction } },
    });

    const newBalance = Number(freshUser.balanceKes) - totalDeduction;

    const transaction = await tx.transaction.create({
      data: {
        userId:      user.id,
        type:        'WITHDRAWAL',
        amountKes:   -amountKes,
        balAfter:    newBalance,
        phone:       formattedPhone,
        mpesaRef:    reference,
        status:      'PENDING',
        description: `Withdrawal of KES ${amountKes} to ${formattedPhone}`,
      },
    });

    return { transaction, freshUser };
  });

  try {
    // Create transfer recipient
    const recipient = await createTransferRecipient({
      name:     user.name ?? `User ${formattedPhone}`,
      phone:    formattedPhone,
      bankCode: 'MPesa',
    });

    // Initiate transfer
    const transfer = await initiateTransfer({
      amountKes,
      recipientCode: recipient.recipient_code,
      reference,
      reason: 'CheckRada Withdrawal',
    });

    await prisma.transaction.update({
      where: { id: result.transaction.id },
      data:  { mpesaRef: transfer.transfer_code },
    });

    return NextResponse.json({
      success:       true,
      message:       `KES ${amountKes} will be sent to ${formattedPhone} shortly.`,
      fee,
      reference,
      transactionId: result.transaction.id,
    });

  } catch (err: any) {
    // Refund balance on failure
    await prisma.$transaction(async (tx: any) => {
      await tx.user.update({
        where: { id: user.id },
        data:  { balanceKes: { increment: totalDeduction } },
      });
      await tx.transaction.update({
        where: { id: result.transaction.id },
        data:  { status: 'FAILED' },
      });
    });

    console.error('[Withdraw] Paystack error:', err.message);
    return NextResponse.json(
      { error: 'Withdrawal failed. Your balance has been restored.' },
      { status: 500 }
    );
  }
});
