// backend/src/app/api/admin/payments/register-c2b/route.ts
//
// One-time (or repeatable) trigger for Safaricom's C2B registerurl call.
// Not called automatically — an admin fires this deliberately, once, after
// confirming DARAJA_C2B_SECRET is set in production.

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';
import { registerC2BUrl }            from '@/lib/daraja/daraja.service';
import { withErrorHandling }         from '@/lib/security/route-guard';

export const POST = withErrorHandling(async (req: NextRequest) => {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const result = await registerC2BUrl();

  await logAdminAction(admin.id, 'C2B_URL_REGISTERED', undefined, { result }, req);

  return NextResponse.json({ success: true, result });
});
