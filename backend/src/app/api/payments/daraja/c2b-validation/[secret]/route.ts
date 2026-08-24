// backend/src/app/api/payments/daraja/c2b-validation/[secret]/route.ts
//
// Safaricom C2B Validation webhook — fires BEFORE a Paybill payment is
// finalised, giving a chance to reject it. Deliberately never rejects here:
// identity matching (MSISDN / BillRefNumber) happens at Confirmation, after
// the money has already moved and can't be undone anyway. Rejecting here
// based on Account Number content would incorrectly block a legitimate payer
// who left it blank or mistyped it — MSISDN matching at Confirmation handles
// that case without needing this step to gatekeep anything.

import { NextRequest, NextResponse } from 'next/server';
import { withErrorHandling }         from '@/lib/security/route-guard';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (
  req:     NextRequest,
  context: { params: { secret: string } }
) => {
  const { secret } = context.params;
  if (!secret || secret !== process.env.DARAJA_C2B_SECRET) {
    console.warn('[Daraja C2B Validation] Invalid callback secret — rejecting');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});
