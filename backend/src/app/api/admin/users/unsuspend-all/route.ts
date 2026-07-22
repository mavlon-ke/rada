// src/app/api/admin/users/unsuspend-all/route.ts
// Emergency: unsuspend ALL suspended users at once.
// POST /api/admin/users/unsuspend-all
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

  const result = await prisma.user.updateMany({
    where: { suspended: true },
    data:  { suspended: false },
  });

  await logAdminAction(
    admin.id,
    'UNSUSPEND_ALL_USERS',
    'all',
    { unsuspended: result.count },
    req
  );

  return NextResponse.json({
    success:     true,
    unsuspended: result.count,
    message:     result.count > 0
      ? `${result.count} user(s) unsuspended.`
      : 'No suspended users found.',
  });
});
