// src/app/api/auth/otp/request/route.ts
// SECURITY FIXES v8:
//   [CRITICAL] Math.random() → crypto.getRandomValues() for OTP
//   [CRITICAL] Math.random() → crypto.randomBytes() for referral code
//   [HIGH]     isNewUser removed from response — user enumeration risk
//   [HIGH]     WhatsApp OTP via Meta Cloud API replaces Africa's Talking SMS
//   [HIGH]     OTP stored in DB ONLY after confirmed delivery

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { prisma } from '@/lib/db/prisma';
import { sendWhatsAppOTP, normaliseToE164 } from '@/lib/whatsapp/whatsapp-otp';
import { withErrorHandling } from '@/lib/security/route-guard';

const Schema = z.object({
  // Accept any international number: optional +, 1-4 digit country code, 4-14 digit subscriber
  // Normalisation and deep validation handled by normaliseToE164
  phone: z.string().min(5).max(20).regex(/^[\+\d][\d\s\-\.\(\)]{3,18}$/, 'Invalid phone number'),
});

// SECURITY: crypto.randomBytes — NOT Math.random()
function generateReferralCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  return 'R' + Array.from(bytes).map(b => chars[b % chars.length]).join('').slice(0, 6);
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body   = await req.json();
  const parsed = Schema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Please enter a valid mobile number including your country code.' },
      { status: 400 }
    );
  }

  const phone = normaliseToE164(parsed.data.phone)!;

  // Upsert user — create with referral code if new, no-op if existing
  const existingUser = await prisma.user.findUnique({ where: { phone } });
  const referralCode = existingUser?.referralCode ?? generateReferralCode();

  await prisma.user.upsert({
    where:  { phone },
    create: { phone, referralCode },
    update: {},
  });

  // Send OTP via WhatsApp
  const result = await sendWhatsAppOTP(phone);

  if (!result.success || !result.otp) {
    console.error(`[OTP Request] WhatsApp delivery failed for ${phone}: ${result.error}`);

    if (result.error === 'NOT_ON_WHATSAPP') {
      return NextResponse.json(
        { error: 'This number does not have WhatsApp. Please use a WhatsApp-enabled number.' },
        { status: 422 }
      );
    }
    if (result.error === 'TEMPLATE_ERROR') {
      console.error('[OTP Request] CRITICAL: WhatsApp template missing or paused.');
      return NextResponse.json(
        { error: 'OTP service temporarily unavailable. Please try again shortly.' },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: 'Could not send OTP. Please try again in a moment.' },
      { status: 500 }
    );
  }

  // Store OTP ONLY after confirmed WhatsApp delivery
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min

  await prisma.otpCode.upsert({
    where:  { phone },
    create: { phone, code: result.otp, expiresAt, attempts: 0 },
    update: { code: result.otp, expiresAt, attempts: 0 },
  });

  // Generic success — never confirm whether phone is new or existing
  return NextResponse.json(
    { message: 'OTP sent via WhatsApp. Check your messages.' },
    { status: 200 }
  );
});
