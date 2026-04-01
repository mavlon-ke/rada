// src/app/api/admin/users/[userId]/route.ts
// PATCH  — edit user fields (name, phone, KYC, balance adjustment, suspended)
// DELETE — permanent delete: credits balance as platform revenue, keeps transaction records

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';

// ─── PATCH /api/admin/users/[userId] ─────────────────────────────────────────

const EditSchema = z.object({
  name:           z.string().min(1).max(100).optional(),
  phone:          z.string().min(9).max(15).optional(),
  kycStatus:      z.enum(['PENDING', 'VERIFIED', 'REJECTED']).optional(),
  suspended:      z.boolean().optional(),
  balanceAdjustKes: z.number().optional(), // positive = credit, negative = debit
  adjustReason:   z.string().max(200).optional(),
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

  const { name, phone, kycStatus, suspended, balanceAdjustKes, adjustReason } = parsed.data;

  // Check phone uniqueness if changing
  if (phone && phone !== user.phone) {
    const existing = await prisma.user.findUnique({ where: { phone } });
    if (existing) {
      return NextResponse.json({ error: 'Phone number already in use by another account' }, { status: 409 });
    }
  }

  // Build user update payload
  const updateData: Record<string, any> = {};
  if (name      !== undefined) updateData.name      = name;
  if (phone     !== undefined) updateData.phone     = phone;
  if (kycStatus !== undefined) updateData.kycStatus = kycStatus;
  if (suspended !== undefined) updateData.suspended = suspended;

  // Handle balance adjustment separately inside a transaction
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
    user: {
      ...updated,
      balanceKes: Number(updated.balanceKes),
    },
  });
}

// ─── DELETE /api/admin/users/[userId] ────────────────────────────────────────
// Permanent delete:
// 1. Logs wallet balance as PLATFORM_COLLECTION transaction
// 2. Cancels all open positions (no refund — balance already credited to platform)
// 3. Deletes the user record (transactions are kept, userId becomes null/orphaned)

export async function DELETE(
  req: NextRequest,
  { params }: { params: { userId: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const user = await prisma.user.findUnique({
    where:   { id: params.userId },
    include: { positions: { where: { shares: { gt: 0 } } } },
  });
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  if (body.confirm !== 'DELETE') {
    return NextResponse.json({ error: 'Must send { confirm: "DELETE" } to permanently delete a user' }, { status: 400 });
  }

  const walletBalance = Number(user.balanceKes) + Number(user.bonusBalanceKes);

  await prisma.$transaction(async (tx) => {
    // Log balance as platform revenue before deletion
    if (walletBalance > 0) {
      await tx.transaction.create({
        data: {
          userId:      params.userId,
          type:        'WITHDRAWAL',
          amountKes:   walletBalance,
          balAfter:    0,
          status:      'SUCCESS',
          description: `PLATFORM_COLLECTION: Account permanently deleted by admin. Wallet balance KES ${walletBalance} collected as platform revenue.`,
        },
      });
    }

    // Zero out all positions
    await tx.position.updateMany({
      where: { userId: params.userId },
      data:  { shares: 0 },
    });

    // Cancel any OTP codes
    await tx.otpCode.deleteMany({ where: { phone: user.phone } });

    // Delete the user — transactions are kept with userId intact for records
    // (Prisma will set userId to null on Transaction if onDelete: SetNull, 
    //  otherwise we keep the userId as a string reference even after user deletion)
    await tx.user.delete({ where: { id: params.userId } });
  });

  await logAdminAction(
    admin.id, 'USER_DELETED', params.userId,
    { phone: user.phone, name: user.name, walletCollected: walletBalance },
    req
  );

  return NextResponse.json({
    success: true,
    message: `User ${user.phone} permanently deleted. KES ${walletBalance} collected as platform revenue.`,
    walletCollected: walletBalance,
  });
}
