// src/lib/auth/admin.ts
// Middleware for /api/admin/* routes — reads from rada_admin_token cookie
// Admin accounts use email/password, never phone OTP

import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { prisma } from '@/lib/db/prisma';

export async function requireAdmin(req: NextRequest) {
  try {
    const token = req.cookies.get('rada_admin_token')?.value
               ?? req.headers.get('authorization')?.replace('Bearer ', '');

    if (!token) return null;

    // SECURITY FIX: admin tokens use a separate secret from user tokens
    if (!process.env.ADMIN_JWT_SECRET) throw new Error('ADMIN_JWT_SECRET not set');
    const secret = new TextEncoder().encode(process.env.ADMIN_JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);

    if (payload.role !== 'ADMIN') return null;

    const admin = await prisma.adminAccount.findUnique({
      where: { id: payload.sub as string },
    });

    return admin ?? null;
  } catch {
    return null;
  }
}

export function adminUnauthorized() {
  return NextResponse.json(
    { error: 'Admin authentication required' },
    { status: 401 }
  );
}

// Log an admin action (call from any admin route)
export async function logAdminAction(
  adminId: string,
  action: string,
  target?: string,
  detail?: object,
  req?: NextRequest
) {
  await prisma.adminActivityLog.create({
    data: {
      adminId,
      action,
      target,
      detail: detail ? JSON.stringify(detail) : undefined,
      ipAddress: req?.headers.get('x-forwarded-for') ?? 'unknown',
    },
  });
}
