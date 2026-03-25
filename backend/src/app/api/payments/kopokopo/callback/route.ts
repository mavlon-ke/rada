// src/app/api/payments/kopokopo/callback/route.ts
// Kopokopo payment callback — with signature verification
import { NextRequest, NextResponse } from 'next/server';
import { verifyKopokopoCAllback } from '@/lib/security/middleware';
import { prisma } from '@/lib/db/prisma';

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get('x-kopokopo-signature') || '';
    const secret = process.env.K2_API_KEY || '';

    // Verify callback signature — reject if invalid
    if (!verifyKopokopoCAllback(rawBody, signature, secret)) {
      console.error('[Security] Invalid Kopokopo callback signature — rejected');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const body = JSON.parse(rawBody);

    // Process verified payment
    // TODO: Wire to actual payment processing logic
    console.log('[Kopokopo] Verified callback received:', body?.event?.type);

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('[Kopokopo] Callback error:', err);
    return NextResponse.json({ error: 'Callback processing failed' }, { status: 500 });
  }
}
