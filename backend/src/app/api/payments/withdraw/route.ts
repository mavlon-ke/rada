// src/app/api/payments/withdraw/route.ts
// Withdrawal via Paystack Transfer (M-Pesa)
// Fee model: Paystack flat fee passed through at zero markup.
// CheckRada earns nothing on withdrawals — revenue comes from forecasting fees.
//
// Fee bands (Paystack Kenya transfer pricing):
//   KES 100  – 1,500:  KES 20 flat
//   KES 1,501 – 20,000: KES 40 flat
//   KES 20,001 – 70,000: KES 60 flat

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/security/route-guard';
import {
  createTransferRecipient,
  initiateTransfer,
  generateReference,
  normalisePhoneForTransfer,
} from '@/lib/paystack/paystack.service';

export const dynamic = 'force-dynamic';

const WithdrawSchema = z.object({
  amountKes: z.number().min(100).max(70000),
  phone:     z.string().min(9).max(15),
});

// Paystack Kenya transfer fee bands — passed through at zero markup
function getPaystackFee(amountKes: number): number {
  if (amountKes <= 1500)  return 20;
  if (amountKes <= 20000) return 40;
  return 60;
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json();
  const parsed = WithdrawSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { amountKes, phone } = parsed.data;
  const paystackFee    = getPaystackFee(amountKes);
  const totalDeduction = amountKes + paystackFee; // deduct amount + fee from wallet
  const formattedPhone = normalisePhoneForTransfer(phone);
  const reference      = generateReference('WIT');

  // Atomic balance check + deduct
  const result = await prisma.$transaction(async (tx: any) => {
    const freshUser = await tx.user.findUnique({ where: { id: user.id } });

    if (!freshUser || Number(freshUser.balanceKes) < totalDeduction) {
      throw new Error(
        `Insufficient balance. Need KES ${totalDeduction.toLocaleString()} (KES ${amountKes.toLocaleString()} + KES ${paystackFee} M-Pesa processing fee).`
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
        description: `Withdrawal of KES ${amountKes.toLocaleString()} to ${formattedPhone}. M-Pesa processing fee: KES ${paystackFee} (Paystack pass-through, zero CheckRada markup).`,
      },
    });

    return { transaction, freshUser };
  });

  try {
    // Create transfer recipient (07XXXXXXXX format)
    const recipient = await createTransferRecipient({
      name:     user.name ?? `User ${formattedPhone}`,
      phone:    formattedPhone,
      bankCode: 'MPesa',
    });

    // Initiate transfer — send amountKes only (paystackFee already deducted from wallet)
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
      success:          true,
      message:          `KES ${amountKes.toLocaleString()} will be sent to your M-Pesa shortly.`,
      amountKes,
      paystackFee,
      totalDeducted:    totalDeduction,
      reference,
      transactionId:    result.transaction.id,
    });

  } catch (err: any) {
    // Refund full deduction (amount + fee) on failure
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
