// src/app/api/payments/paystack/callback/route.ts
// Handles redirect after card payment on Paystack
// Paystack redirects here with ?reference=xxx after card payment

import { NextRequest, NextResponse } from 'next/server';
import { verifyTransaction } from '@/lib/paystack/paystack.service';
import { prisma } from '@/lib/db/prisma';
import { withErrorHandling } from '@/lib/security/route-guard';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const reference = searchParams.get('reference');

  if (!reference) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_BASE_URL?.replace('api.', '')}/rada-dashboard.html?deposit=failed`
    );
  }

  try {
    const result = await verifyTransaction(reference);

    if (result.status === 'success') {
      // Webhook will handle the actual balance credit
      // Just redirect user to success page
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL?.replace('api.', '')}/rada-dashboard.html?deposit=success&ref=${reference}`
      );
    } else {
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL?.replace('api.', '')}/rada-dashboard.html?deposit=failed`
      );
    }
  } catch (err) {
    console.error('[Paystack Callback] Error:', err);
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_BASE_URL?.replace('api.', '')}/rada-dashboard.html?deposit=failed`
    );
  }
});
