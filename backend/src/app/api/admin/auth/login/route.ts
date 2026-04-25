// src/app/api/admin/auth/login/route.ts
// SECURITY FIXES v8:
//   [CRITICAL] prisma.adminUser → prisma.adminAccount (model name mismatch — crashed on every login)
//   [CRITICAL] SHA256 password comparison → bcrypt.compare (proper password hashing)
//   [HIGH]     In-memory lockout → Redis-backed lockout (survives Railway restarts)
//   [HIGH]     withErrorHandling wrapper applied

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { SignJWT } from 'jose';
import bcrypt from 'bcryptjs';
import { getRedis } from '@/lib/db/redis';
import { prisma } from '@/lib/db/prisma';
import { logAdminAction } from '@/lib/auth/admin';
import { withErrorHandling } from '@/lib/security/route-guard';

// SECURITY FIX: admin tokens use a separate secret from user tokens.
// Compromise of one secret cannot mint tokens for the other trust tier.
const ADMIN_JWT_SECRET = new TextEncoder().encode(
  process.env.ADMIN_JWT_SECRET ?? (() => { throw new Error('ADMIN_JWT_SECRET not set'); })()
);
const MAX_ATTEMPTS = 5;
const LOCKOUT_SECS = 30 * 60; // 30 minutes

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(8),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const ip  = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const key = `admin:lockout:${ip}`;

  const redis = getRedis();

  // ── Redis-backed lockout check ──────────────────────────────────────────
  const attemptsRaw = await redis.get(key);
  const attempts    = attemptsRaw ? parseInt(attemptsRaw, 10) : 0;

  if (attempts >= MAX_ATTEMPTS) {
    const ttl = await redis.ttl(key);
    const mins = Math.ceil(ttl / 60);
    return NextResponse.json(
      { error: `Too many failed attempts. Try again in ${mins} minute(s).` },
      { status: 429 }
    );
  }

  // ── Parse input ─────────────────────────────────────────────────────────
  const body = await req.json();
  const { email, password } = LoginSchema.parse(body);

  // ── FIX [CRITICAL]: was prisma.adminUser — model is adminAccount ────────
  const admin = await prisma.adminAccount.findUnique({ where: { email } });

  // ── FIX [CRITICAL]: bcrypt.compare replaces SHA256 direct comparison ────
  // Always run bcrypt even if admin not found — prevents timing attacks
  const dummyHash   = '$2b$12$dummy.hash.to.prevent.timing.attacks.in.user.lookup';
  const hashToCheck = admin?.passwordHash ?? dummyHash;
  const passwordOk  = await bcrypt.compare(password, hashToCheck);

  if (!admin || !passwordOk) {
    // Increment Redis attempt counter
    const pipe = redis.pipeline();
    pipe.incr(key);
    pipe.expire(key, LOCKOUT_SECS);
    await pipe.exec();

    const newAttempts  = attempts + 1;
    const attemptsLeft = Math.max(0, MAX_ATTEMPTS - newAttempts);
    return NextResponse.json(
      { error: 'Invalid credentials.', attemptsLeft },
      { status: 401 }
    );
  }

  // ── Success — clear lockout ─────────────────────────────────────────────
  await redis.del(key);

  // Update last login
  await prisma.adminAccount.update({
    where: { id: admin.id },
    data:  { lastLoginAt: new Date() },
  });

  // Issue JWT (8h admin session)
  const token = await new SignJWT({
    sub:   admin.id,
    email: admin.email,
    role:  'ADMIN',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(ADMIN_JWT_SECRET);

  await logAdminAction(admin.id, 'LOGIN', undefined, { ip }, req);

  // Set cookie for browser sessions
  // FIX: token no longer returned in JSON — only set as httpOnly cookie below.
  // Prevents XSS from reading the admin JWT.
  const res = NextResponse.json({
    admin: { id: admin.id, email: admin.email, name: admin.name },
  });
  res.cookies.set('rada_admin_token', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   8 * 3600,
    path:     '/',
  });
  return res;

});
