// backend/src/app/api/admin/payments/c2b-deposits/[transactionId]/dismiss/route.ts
//
// Soft-dismiss — moves a PENDING row to FAILED. Never a hard delete: this
// represents real money that arrived, and the record should survive for
// reconciliation against the M-Pesa Business Portal even if you're not
// actively chasing it down. Scoped so this can only ever touch a still-
// PENDING, still-unmatched row — never a completed SUCCESS transaction.

import { NextRequest, NextResponse } from 'next/server';
import { prisma }                    from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';
import { withErrorHandling }         from '@/lib/security/route-guard';

export const POST = withErrorHandling(async (
  req:     NextRequest,
  context: { params: { transactionId: string } }
) => {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const { transactionId } = context.params;

  const claimed = await prisma.transaction.updateMany({
    where: { id: transactionId, status: 'PENDING', userId: null },
    data:  { status: 'FAILED' },
  });

  if (claimed.count === 0) {
    return NextResponse.json({ error: 'This deposit is no longer pending.' }, { status: 409 });
  }

  await logAdminAction(admin.id, 'C2B_DEPOSIT_DISMISSED', transactionId, {}, req);

  return NextResponse.json({ success: true });
});
