// src/app/api/admin/users/[userId]/route.ts
// PATCH  — edit user fields (name, phone, balance adjustment, suspended)
// DELETE — permanent delete with optional blacklist

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';

// ─── PATCH /api/admin/users/[userId] ─────────────────────────────────────────

const EditSchema = z.object({
  name:             z.string().min(1).max(100).optional(),
  phone:            z.string().min(9).max(15).optional(),
  suspended:        z.boolean().optional(),
  balanceAdjustKes: z.number().optional(),
  adjustReason:     z.string().max(200).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: { userId: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const user = await prisma.user.findUnique({ where: { id: params.userId } });
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const body   = await req.json();
  const parsed = EditSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { name, phone, suspended, balanceAdjustKes, adjustReason } = parsed.data;

  // Check phone uniqueness if changing
  if (phone && phone !== user.phone) {
    const existing = await prisma.user.findUnique({ where: { phone } });
    if (existing) {
      return NextResponse.json({ error: 'Phone number already in use by another account' }, { status: 409 });
    }
  }

  const updateData: Record<string, any> = {};
  if (name      !== undefined) updateData.name      = name;
  if (phone     !== undefined) updateData.phone     = phone;
  if (suspended !== undefined) updateData.suspended = suspended;

  const updated = await prisma.$transaction(async (tx) => {
    let updatedUser = user;

    if (Object.keys(updateData).length > 0) {
      updatedUser = await tx.user.update({
        where: { id: params.userId },
        data:  updateData,
      });
    }

    if (balanceAdjustKes !== undefined && balanceAdjustKes !== 0) {
      const newBalance = Number(user.balanceKes) + balanceAdjustKes;
      if (newBalance < 0) {
        throw new Error('Balance adjustment would result in negative balance');
      }

      updatedUser = await tx.user.update({
        where: { id: params.userId },
        data:  { balanceKes: newBalance },
      });

      await tx.transaction.create({
        data: {
          userId:      params.userId,
          type:        balanceAdjustKes > 0 ? 'DEPOSIT' : 'WITHDRAWAL',
          amountKes:   Math.abs(balanceAdjustKes),
          balAfter:    newBalance,
          status:      'SUCCESS',
          description: `Admin manual adjustment: ${balanceAdjustKes > 0 ? '+' : ''}KES ${balanceAdjustKes}. Reason: ${adjustReason || 'Admin action'}`,
        },
      });
    }

    return updatedUser;
  });

  await logAdminAction(
    admin.id, 'USER_EDITED', params.userId,
    { fields: Object.keys({ ...updateData, ...(balanceAdjustKes ? { balance: balanceAdjustKes } : {}) }) },
    req
  );

  return NextResponse.json({
    success: true,
    user: { ...updated, balanceKes: Number(updated.balanceKes) },
  });
}

// ─── DELETE /api/admin/users/[userId] ────────────────────────────────────────
// 1. Sweep wallet to PlatformRevenue (USER_DELETION type)
// 2. Zero out positions (keep records with null userId via onDelete: SetNull)
// 3. Delete referrals (can't SetNull due to unique constraint)
// 4. Delete notifications (no audit value)
// 5. Delete OTP codes
// 6. Optionally blacklist the phone number
// 7. Delete the user — FK relations use onDelete: SetNull so records are kept

const DeleteSchema = z.object({
  confirm:   z.literal('DELETE'),
  blacklist: z.boolean().optional().default(false),
  reason:    z.string().max(200).optional(),
});

export async function DELETE(
  req: NextRequest,
  { params }: { params: { userId: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
  });
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Must send { confirm: "DELETE" } to permanently delete a user' },
      { status: 400 }
    );
  }

  const { blacklist, reason } = parsed.data;
  const walletBalance = Number(user.balanceKes) + Number(user.bonusBalanceKes);

  await prisma.$transaction(async (tx) => {
    // 1. Sweep wallet balance to platform revenue
    if (walletBalance > 0) {
      await tx.platformRevenue.create({
        data: {
          type:        'USER_DELETION',
          amountKes:   walletBalance,
          description: `Account permanently deleted by admin. Wallet balance KES ${walletBalance} swept to platform. User: ${user.phone} (${user.name || 'no name'}).`,
        },
      });
      // Also create a transaction record for the user's history
      await tx.transaction.create({
        data: {
          userId:      user.id,
          type:        'WITHDRAWAL',
          amountKes:   walletBalance,
          balAfter:    0,
          status:      'SUCCESS',
          description: `ACCOUNT_DELETED: Wallet balance swept to platform revenue on account deletion.`,
        },
      });
    }

    // 2. Zero out all positions (shares become 0 — records kept with null userId after delete)
    await tx.position.updateMany({
      where: { userId: user.id },
      data:  { shares: 0 },
    });

    // 3. Delete referrals (unique constraint on refereeId prevents SetNull)
    await tx.referral.deleteMany({
      where: { OR: [{ referrerId: user.id }, { refereeId: user.id }] },
    });

    // 4. Delete notifications (no audit value)
    await tx.notification.deleteMany({ where: { userId: user.id } });

    // 5. Delete OTP codes
    await tx.otpCode.deleteMany({ where: { phone: user.phone } });

    // 6. Blacklist the phone number if requested
    if (blacklist) {
      await tx.blacklist.upsert({
        where:  { phone: user.phone },
        create: {
          phone:             user.phone,
          reason:            reason || 'Account deleted by admin',
          createdByAdminId:  admin.id,
        },
        update: {
          reason:            reason || 'Account deleted by admin',
          createdByAdminId:  admin.id,
        },
      });
    }

    // 7. Delete the user — onDelete: SetNull handles Order, Transaction, Market, etc.
    await tx.user.delete({ where: { id: user.id } });
  });

  await logAdminAction(
    admin.id, 'USER_DELETED', params.userId,
    { phone: user.phone, name: user.name, walletCollected: walletBalance, blacklisted: blacklist },
    req
  );

  return NextResponse.json({
    success:         true,
    message:         `User ${user.phone} permanently deleted.${walletBalance > 0 ? ` KES ${walletBalance} swept to platform revenue.` : ''}${blacklist ? ' Phone number blacklisted.' : ''}`,
    walletCollected: walletBalance,
    blacklisted:     blacklist,
  });
}
