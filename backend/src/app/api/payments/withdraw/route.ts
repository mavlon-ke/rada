// src/app/api/payments/withdraw/route.ts
// Withdrawal via Paystack Transfer (M-Pesa)
//
// Fee model: processing fee deducted FROM the withdrawal amount.
// User enters amount to withdraw from wallet.
// Wallet is debited the full entered amount.
// M-Pesa receives: amountKes - paystackFee.
// User can always withdraw their full wallet balance.
//
// Fee bands (Paystack Kenya transfer pricing):
//   KES 100  – 1,500:  KES 20 flat  → user receives amountKes - 20
//   KES 1,501 – 20,000: KES 40 flat → user receives amountKes - 40
//   KES 20,001 – 70,000: KES 60 flat → user receives amountKes - 60

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

// Paystack Kenya transfer fee bands
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
  const paystackFee   = getPaystackFee(amountKes);
  const transferAmount = amountKes - paystackFee; // amount sent to M-Pesa
  const formattedPhone = normalisePhoneForTransfer(phone);
  const reference      = generateReference('WIT');

  // Guard: transfer amount must be positive
  if (transferAmount <= 0) {
    return NextResponse.json(
      { error: `Withdrawal amount too small. Minimum is KES ${paystackFee + 1} after the KES ${paystackFee} processing fee.` },
      { status: 400 }
    );
  }

  // Atomic balance check + deduct full amountKes from wallet
  const result = await prisma.$transaction(async (tx: any) => {
    const freshUser = await tx.user.findUnique({ where: { id: user.id } });

    if (!freshUser || Number(freshUser.balanceKes) < amountKes) {
      throw new Error(
        `Insufficient balance. Available: KES ${Number(freshUser?.balanceKes ?? 0).toLocaleString()}`
      );
    }

    await tx.user.update({
      where: { id: user.id },
      data:  { balanceKes: { decrement: amountKes } },
    });

    const newBalance = Number(freshUser.balanceKes) - amountKes;

    const transaction = await tx.transaction.create({
      data: {
        userId:      user.id,
        type:        'WITHDRAWAL',
        amountKes:   -amountKes,
        balAfter:    newBalance,
        phone:       formattedPhone,
        mpesaRef:    reference,
        status:      'PENDING',
        description: `Withdrawal of KES ${amountKes.toLocaleString()} from wallet. M-Pesa processing fee KES ${paystackFee} deducted — KES ${transferAmount.toLocaleString()} sent to ${formattedPhone}.`,
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

    // Send transferAmount (amountKes minus fee) to M-Pesa
    const transfer = await initiateTransfer({
      amountKes:     transferAmount,
      recipientCode: recipient.recipient_code,
      reference,
      reason: 'CheckRada Withdrawal',
    });

    await prisma.transaction.update({
      where: { id: result.transaction.id },
      data:  { mpesaRef: transfer.transfer_code },
    });

    return NextResponse.json({
      success:        true,
      message:        `KES ${transferAmount.toLocaleString()} will be sent to your M-Pesa shortly.`,
      amountKes,
      paystackFee,
      transferAmount,
      reference,
      transactionId:  result.transaction.id,
    });

  } catch (err: any) {
    // Refund full amountKes on failure
    await prisma.$transaction(async (tx: any) => {
      await tx.user.update({
        where: { id: user.id },
        data:  { balanceKes: { increment: amountKes } },
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
