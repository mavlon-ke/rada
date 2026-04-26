// src/app/api/payments/deposit/route.ts
// Deposit via Paystack — M-Pesa STK Push or Card
// Replaces: Safaricom Daraja direct integration

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/security/route-guard';
import {
  chargeMpesa,
  initializeTransaction,
  generateReference,
  normalisePhone,
} from '@/lib/paystack/paystack.service';

export const dynamic = 'force-dynamic';

const DepositSchema = z.object({
  amountKes: z.number().int().min(10).max(70000),
  phone:     z.string().min(9).max(15),
  method:    z.enum(['mpesa', 'card']).default('mpesa'),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json();
  const parsed = DepositSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { amountKes, phone, method } = parsed.data;
  const reference  = generateReference('DEP');
  const formattedPhone = normalisePhone(phone);

  // Paystack requires an email — use phone-based synthetic email as fallback
  const email = `${formattedPhone}@checkrada.co.ke`;

  // Create pending transaction record
  const transaction = await prisma.transaction.create({
    data: {
      userId:      user.id,
      type:        'DEPOSIT',
      amountKes,
      balAfter:    Number(user.balanceKes) + amountKes,
      phone:       formattedPhone,
      mpesaRef:    reference,
      status:      'PENDING',
      description: `${method === 'card' ? 'Card' : 'M-Pesa'} deposit of KES ${amountKes}`,
    },
  });

  try {
    if (method === 'mpesa') {
      // ── M-Pesa STK Push via Paystack ───────────────────────────────────────
      const result = await chargeMpesa({
        email,
        amountKes,
        phone: formattedPhone,
        reference,
        metadata: {
          userId:        user.id,
          transactionId: transaction.id,
          platform:      'checkrada',
        },
      });

      return NextResponse.json({
        success:       true,
        method:        'mpesa',
        reference,
        transactionId: transaction.id,
        message:       result.display_text || 'Check your phone for the M-Pesa prompt.',
        status:        result.status,
      });

    } else {
      // ── Card payment — return Paystack authorization URL ───────────────────
      const result = await initializeTransaction({
        email,
        amountKes,
        reference,
        callbackUrl: `${process.env.NEXT_PUBLIC_BASE_URL}/api/payments/paystack/callback`,
        metadata: {
          userId:        user.id,
          transactionId: transaction.id,
          platform:      'checkrada',
        },
      });

      return NextResponse.json({
        success:           true,
        method:            'card',
        reference,
        transactionId:     transaction.id,
        authorization_url: result.authorization_url,
        message:           'Redirecting to secure payment page.',
      });
    }

  } catch (err: any) {
    // Mark transaction as failed
    await prisma.transaction.update({
      where: { id: transaction.id },
      data:  { status: 'FAILED' },
    });

    console.error('[Deposit] Paystack error:', err.message);
    return NextResponse.json(
      { error: err.message || 'Payment initiation failed. Please try again.' },
      { status: 500 }
    );
  }
});
