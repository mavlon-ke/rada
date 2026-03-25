// src/app/api/auth/otp/verify/route.ts
// SECURITY FIXES v8:
//   [CRITICAL] record.expires_at → record.expiresAt (field name bug — crashed on every verify)
//   [HIGH]     Timing-safe OTP comparison (prevents enumeration via response time)
//   [HIGH]     withErrorHandling wrapper applied

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { SignJWT } from 'jose';
import { timingSafeEqual } from 'crypto';
import { prisma } from '@/lib/db/prisma';
import { withErrorHandling } from '@/lib/security/route-guard';
import { normaliseToE164 } from '@/lib/whatsapp/whatsapp-otp';

const Schema = z.object({
  phone:        z.string(),
  code:         z.string().length(6).regex(/^\d{6}$/, 'OTP must be 6 digits'),
  referralCode: z.string().optional(),
});

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? (() => { throw new Error('JWT_SECRET not set'); })()
);

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body   = await req.json();
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const phone = normaliseToE164(parsed.data.phone);
  if (!phone) {
    return NextResponse.json({ error: 'Invalid phone number' }, { status: 400 });
  }

  const { code, referralCode } = parsed.data;

  const record = await prisma.otpCode.findFirst({
    where:   { phone, expiresAt: { gt: new Date() } },
    orderBy: { expiresAt: 'desc' },
  });

  if (!record) {
    return NextResponse.json({ error: 'Code expired or not found. Please request a new one.' }, { status: 401 });
  }

  if (record.attempts >= 5) {
    return NextResponse.json({ error: 'Too many attempts. Please request a new code.' }, { status: 429 });
  }

  // FIX [CRITICAL]: was record.expires_at — field is expiresAt in schema
  if (new Date() > record.expiresAt) {
    return NextResponse.json({ error: 'Code expired. Please request a new one.' }, { status: 401 });
  }

  // FIX [HIGH]: Timing-safe comparison — prevents OTP enumeration via response time
  let codeMatch = false;
  try {
    const storedBuf = Buffer.from(record.code, 'utf8');
    const inputBuf  = Buffer.from(code,        'utf8');
    codeMatch = storedBuf.length === inputBuf.length && timingSafeEqual(storedBuf, inputBuf);
  } catch {
    codeMatch = false;
  }

  if (!codeMatch) {
    await prisma.otpCode.updateMany({
      where: { phone },
      data:  { attempts: { increment: 1 } },
    });
    return NextResponse.json({ error: 'Incorrect code. Please try again.' }, { status: 401 });
  }

  // Consume OTP immediately — one-time use
  await prisma.otpCode.deleteMany({ where: { phone } });

  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // ── Referral capture ────────────────────────────────────────────────────────
  if (referralCode && !user.referredBy) {
    const referrer = await prisma.user.findUnique({
      where: { referralCode: referralCode.toUpperCase().trim() },
    });
    if (referrer && referrer.id !== user.id) {
      const config = await prisma.referralConfig.findUnique({ where: { id: 'singleton' } });
      if (config?.active) {
        await prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: user.id },
            data:  { referredBy: referrer.id },
          });
          await tx.referral.upsert({
            where:  { refereeId: user.id },
            create: { referrerId: referrer.id, refereeId: user.id, status: 'PENDING' },
            update: {},
          });
        });
      }
    }
  }

  // Update last login
  await prisma.user.update({
    where: { id: user.id },
    data:  { updatedAt: new Date() },
  });

  // Issue JWT
  const token = await new SignJWT({ sub: user.id, phone: user.phone })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(JWT_SECRET);

  const freshUser = await prisma.user.findUnique({
    where:  { id: user.id },
    select: { id: true, phone: true, name: true, balanceKes: true,
              bonusBalanceKes: true, kycStatus: true, referralCode: true,
              agreedToTerms: true, confirmedAge: true, createdAt: true },
  });

  const res = NextResponse.json({ token, user: freshUser });
  res.cookies.set('token', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   86400,
    path:     '/',
  });

  return res;
});
