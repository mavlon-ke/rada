// src/app/api/payments/deposit/route.ts
// M-Pesa deposit via Safaricom Daraja STK Push (Lipa Na M-Pesa Online).
//
// Flow:
//   1. Validate request and authenticate user
//   2. Create PENDING transaction with temporary accountRef as mpesaRef
//   3. Fire STK Push → Safaricom returns CheckoutRequestID
//   4. Update transaction.mpesaRef = CheckoutRequestID (callback lookup key)
//   5. Return success — user sees M-Pesa prompt on their phone
//
// Confirmation arrives asynchronously via:
//   POST /api/payments/daraja/stk-callback/[DARAJA_CALLBACK_SECRET]

import { NextRequest, NextResponse } from 'next/server';
import { z }                         from 'zod';
import { prisma }                    from '@/lib/db/prisma';
import { requireAuth }               from '@/lib/auth/session';
import { withErrorHandling }         from '@/lib/security/route-guard';
import { stkPush, generateDarajaRef, darajaPhone } from '@/lib/daraja/daraja.service';

export const dynamic = 'force-dynamic';

const DepositSchema = z.object({
  amountKes: z.number().int().min(10).max(70000),
  phone:     z.string().min(9).max(15),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json();
  const parsed = DepositSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { amountKes, phone } = parsed.data;
  const normPhone  = darajaPhone(phone);
  const accountRef = generateDarajaRef('CRD'); // 11-char reference — used as AccountReference

  // Create PENDING record before STK push — ensures a DB record always exists
  // even if the STK push succeeds but the subsequent mpesaRef update fails.
  const transaction = await prisma.transaction.create({
    data: {
      userId:      user.id,
      type:        'DEPOSIT',
      amountKes,
      balAfter:    0,           // updated to real value in the STK callback after confirmation
      phone:       normPhone,
      mpesaRef:    accountRef,  // temporary — updated to CheckoutRequestID below
      status:      'PENDING',
      description: `M-Pesa deposit of KES ${amountKes.toLocaleString()} — awaiting STK confirmation`,
    },
  });

  try {
    const stkResult = await stkPush({
      amountKes,
      phone:            normPhone,
      accountReference: accountRef,
      transactionDesc:  'CheckRada Dep', // max 13 chars
    });

    // Update mpesaRef to CheckoutRequestID — this is what the STK callback sends
    // and what the callback handler uses to look up and credit this transaction.
    try {
      await prisma.transaction.update({
        where: { id: transaction.id },
        data:  { mpesaRef: stkResult.CheckoutRequestID },
      });
    } catch (updateErr: any) {
      // Non-fatal: STK push is already in flight. Log both refs so admin can reconcile
      // manually if the callback cannot find the transaction.
      console.error(
        `[Deposit] CRITICAL: mpesaRef update failed for transaction ${transaction.id}. ` +
        `accountRef=${accountRef} CheckoutRequestID=${stkResult.CheckoutRequestID}. ` +
        `Error: ${updateErr.message}`
      );
    }

    return NextResponse.json({
      success:       true,
      transactionId: transaction.id,
      reference:     accountRef,
      message:       stkResult.CustomerMessage || 'Check your phone for the M-Pesa prompt.',
    });

  } catch (err: any) {
    // STK push failed — mark transaction failed (do not leave it PENDING)
    await prisma.transaction.update({
      where: { id: transaction.id },
      data:  { status: 'FAILED', description: `STK Push failed: ${err.message}` },
    }).catch(() => {});

    console.error('[Deposit] STK Push error:', err.message);
    return NextResponse.json(
      { error: err.message || 'Could not initiate M-Pesa payment. Please try again.' },
      { status: 500 }
    );
  }
});
