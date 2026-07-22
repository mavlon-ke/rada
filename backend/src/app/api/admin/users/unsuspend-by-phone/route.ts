// src/app/api/admin/users/unsuspend-by-phone/route.ts
// Emergency: unsuspend a specific user by phone number.
// POST /api/admin/users/unsuspend-by-phone
// Body: { phone: string }
//
// Auth: requires valid admin session (requireAdmin).
// Previously GET with secret in query string — secret was exposed in server
// logs, browser history, and CDN access logs. Moved to POST + requireAdmin.
// logAdminAction creates a full audit trail for every use.

import { NextRequest, NextResponse }                  from 'next/server';
import { prisma }                                     from '@/lib/db/prisma';
import { withErrorHandling }                          from '@/lib/security/route-guard';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const body = await req.json().catch(() => ({}));
  const phone = body?.phone as string | undefined;

  if (!phone) {
    return NextResponse.json({ error: 'phone required in request body' }, { status: 400 });
  }

  const digits = phone.replace(/\D/g, '');
  const e164   = digits.startsWith('0') && digits.length === 10
    ? '254' + digits.slice(1) : digits;

  const result = await prisma.user.updateMany({
    where: { phone: { in: [e164, '0' + e164.slice(3)] } },
    data:  { suspended: false },
  });

  await logAdminAction(
    admin.id,
    'UNSUSPEND_USER',
    `phone:${e164}`,
    { phone: e164, updated: result.count },
    req
  );

  return NextResponse.json({
    success: true,
    updated: result.count,
    message: result.count > 0 ? 'User unsuspended.' : 'User not found.',
  });
});
