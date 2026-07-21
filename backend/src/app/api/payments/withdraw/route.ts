// src/app/api/payments/withdraw/route.ts
// Withdrawal via Safaricom Daraja B2C (Business to Customer).
//
// Full amount entered by user is sent directly to their M-Pesa.
// No processing fee — Daraja B2C has no per-transaction charge to the user.
//
// In-flight guard: rejects if a PENDING withdrawal already exists for this user,
// preventing duplicate withdrawals from simultaneous requests.
//
// Confirmation arrives asynchronously via:
//   POST /api/payments/daraja/b2c-result/[DARAJA_CALLBACK_SECRET]
// Timeout handled via:
//   POST /api/payments/daraja/b2c-timeout/[DARAJA_CALLBACK_SECRET]

import { NextRequest, NextResponse } from 'next/server';
import { z }                         from 'zod';
import { prisma }                    from '@/lib/db/prisma';
import { requireAuth }               from '@/lib/auth/session';
import { withErrorHandling }         from '@/lib/security/route-guard';
import { b2cTransfer, generateDarajaRef, darajaPhone } from '@/lib/payments/payment.service';

export const dynamic = 'force-dynamic';

const WithdrawSchema = z.object({
  amountKes: z.number().min(100).max(70000),
  phone:     z.string().min(9).max(15),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json();
  const parsed = WithdrawSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { amountKes, phone } = parsed.data;
  const normPhone  = darajaPhone(phone);
  const accountRef = generateDarajaRef('CRW'); // 11-char reference

  // ── In-flight guard (C-4 fix) ─────────────────────────────────────────────
  // Reject if a withdrawal is already in progress for this user.
  // Scoped to the last 10 minutes — Daraja B2C completes in seconds; anything
  // older than 10 minutes is definitively stuck (network failure, prior payment
  // provider migration) and must not block new attempts.
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  const existing = await prisma.transaction.findFirst({
    where: {
      userId:    user.id,
      type:      'WITHDRAWAL',
      status:    'PENDING',
      createdAt: { gte: tenMinutesAgo },
    },
  });
  if (existing) {
    return NextResponse.json(
      { error: 'A withdrawal is already being processed. Please wait for it to complete.' },
      { status: 400 }
    );
  }

  // ── Atomic balance check + debit ─────────────────────────────────────────
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
        phone:       normPhone,
        mpesaRef:    accountRef, // updated to OriginatorConversationID after B2C call
        status:      'PENDING',
        description: `Withdrawal of KES ${amountKes.toLocaleString()} to M-Pesa ${normPhone}`,
      },
    });

    return { transaction, newBalance };
  });

  // ── Fire B2C transfer ────────────────────────────────────────────────────
  try {
    const b2cResult = await b2cTransfer({
      amountKes,
      phone:     normPhone,
      reference: accountRef,
    });

    // Update mpesaRef to OriginatorConversationID — used by B2C callback for lookup
    try {
      await prisma.transaction.update({
        where: { id: result.transaction.id },
        data:  { mpesaRef: b2cResult.OriginatorConversationID },
      });
    } catch (updateErr: any) {
      console.error(
        `[Withdraw] CRITICAL: mpesaRef update failed for transaction ${result.transaction.id}. ` +
        `accountRef=${accountRef} OriginatorConversationID=${b2cResult.OriginatorConversationID}. ` +
        `Error: ${updateErr.message}`
      );
    }

    return NextResponse.json({
      success:       true,
      message:       `KES ${amountKes.toLocaleString()} is being sent to your M-Pesa. You will receive an M-Pesa confirmation shortly.`,
      amountKes,
      transactionId: result.transaction.id,
    });

  } catch (err: any) {
    // B2C failed — refund wallet atomically
    await prisma.$transaction(async (tx: any) => {
      await tx.user.update({
        where: { id: user.id },
        data:  { balanceKes: { increment: amountKes } },
      });
      await tx.transaction.update({
        where: { id: result.transaction.id },
        data:  { status: 'FAILED', description: `Withdrawal failed: ${err.message}` },
      });
    }).catch((refundErr: any) => {
      console.error('[Withdraw] CRITICAL: refund also failed:', refundErr.message);
    });

    console.error('[Withdraw] B2C error:', err.message);
    return NextResponse.json(
      { error: 'Withdrawal could not be initiated. Your balance has been restored.' },
      { status: 500 }
    );
  }
});
