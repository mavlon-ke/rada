// backend/src/app/api/admin/payments/c2b-deposits/[transactionId]/reconcile/route.ts
//
// Atomically: credits the named user's wallet, flips the PENDING row to
// SUCCESS with userId linked, and notifies them. Status-guarded so this can
// only ever fire once per row — same pattern used throughout the platform's
// money-moving routes.
//
// ATOMICITY FIX: the status-guarded claim (PENDING → SUCCESS) and the
// wallet credit are now inside ONE $transaction, not two separate
// operations. Previously, if the credit step failed after the claim had
// already committed, the row would be stuck marked SUCCESS and linked to a
// user whose wallet was never actually credited — with no PENDING state
// left to retry from. Now both commit together or neither does.

import { NextRequest, NextResponse } from 'next/server';
import { prisma }                    from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';
import { withErrorHandling }         from '@/lib/security/route-guard';
import { darajaPhone }               from '@/lib/daraja/daraja.service';
import { sendWhatsAppNotification }  from '@/lib/whatsapp/whatsapp-notifications';

export const POST = withErrorHandling(async (
  req:     NextRequest,
  context: { params: { transactionId: string } }
) => {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const { transactionId } = context.params;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const phone = String(body?.phone ?? '').trim();
  if (!phone) return NextResponse.json({ error: 'phone is required' }, { status: 400 });

  const pending = await prisma.transaction.findUnique({ where: { id: transactionId } });
  if (!pending || pending.status !== 'PENDING' || pending.userId !== null) {
    return NextResponse.json({ error: 'This deposit is no longer pending reconciliation.' }, { status: 409 });
  }

  const targetUser = await prisma.user.findUnique({ where: { phone: darajaPhone(phone) } });
  if (!targetUser) {
    return NextResponse.json({ error: 'No CheckRada user found with that phone number.' }, { status: 404 });
  }

  const amountKes = Number(pending.amountKes);

  try {
    await prisma.$transaction(async (tx) => {
      // Status-guarded claim — prevents two admins (or a double-click) from
      // reconciling the same PENDING row twice.
      const claimed = await tx.transaction.updateMany({
        where: { id: transactionId, status: 'PENDING', userId: null },
        data:  {
          status:      'SUCCESS',
          userId:      targetUser.id,
          description: `${pending.description ?? ''} — manually reconciled by admin to ${darajaPhone(phone)}.`,
        },
      });

      if (claimed.count === 0) {
        throw new Error('ALREADY_RECONCILED');
      }

      const freshUser = await tx.user.findUnique({ where: { id: targetUser.id } });
      if (!freshUser) return;
      const newBalance = Number(freshUser.balanceKes) + amountKes;

      await tx.user.update({
        where: { id: targetUser.id },
        data:  { balanceKes: { increment: amountKes } },
      });

      await tx.transaction.update({
        where: { id: transactionId },
        data:  { balAfter: newBalance },
      });

      await tx.notification.create({
        data: {
          userId:  targetUser.id,
          type:    'DEPOSIT_CONFIRMED',
          title:   '✅ Deposit confirmed',
          message: `KES ${amountKes.toLocaleString()} has been added to your CheckRada wallet.`,
          link:    '/rada-dashboard.html',
        },
      });
    });
  } catch (err: any) {
    if (err.message === 'ALREADY_RECONCILED') {
      return NextResponse.json({ error: 'This deposit was just reconciled by someone else.' }, { status: 409 });
    }
    throw err;
  }

  void sendWhatsAppNotification(targetUser.id, 'DEPOSIT_CONFIRMED', [amountKes.toLocaleString()]);

  await logAdminAction(admin.id, 'C2B_DEPOSIT_RECONCILED', transactionId, { userId: targetUser.id, amountKes }, req);

  return NextResponse.json({ success: true });
});
