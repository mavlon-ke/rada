import { withErrorHandling } from '@/lib/security/route-guard';
// src/app/api/admin/bounties/route.ts
// GET  — list all creator bounties with unpaid balance
// POST — trigger M-Pesa payout to a creator

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';

import { initiateTransfer, createTransferRecipient, normalisePhone as formatPhone } from '@/lib/paystack/paystack.service';

const BOUNTY_MIN_PAYOUT = 100; // Only pay out when balance ≥ KES 100

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const bounties = await prisma.creatorBounty.findMany({
    where:   { active: true },
    include: {
      creator: { select: { phone: true, name: true } },
      market:  { select: { title: true } },
    },
    orderBy: { bountyEarned: 'desc' },
  });

  return NextResponse.json({ bounties });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const { bountyId } = await req.json();
  if (!bountyId) return NextResponse.json({ error: 'bountyId required' }, { status: 400 });

  const bounty = await prisma.creatorBounty.findUnique({
    where:   { id: bountyId },
    include: { creator: true, market: { select: { title: true } } },
  });

  if (!bounty) return NextResponse.json({ error: 'Bounty not found' }, { status: 404 });

  const unpaid = Number(bounty.bountyEarned) - Number(bounty.paidOut);
  if (unpaid < BOUNTY_MIN_PAYOUT) {
    return NextResponse.json({
      error: `Unpaid balance KES ${unpaid.toFixed(2)} is below minimum payout threshold of KES ${BOUNTY_MIN_PAYOUT}`,
    }, { status: 400 });
  }

  const payoutKes = Math.floor(unpaid);

  await prisma.$transaction(async (tx) => {
    // Credit wallet
    const updated = await tx.user.update({
      where: { id: bounty.creatorId },
      data:  { balanceKes: { increment: payoutKes } },
    });

    // Update bounty record
    await tx.creatorBounty.update({
      where: { id: bountyId },
      data:  { paidOut: { increment: payoutKes }, lastPaidAt: new Date() },
    });

    // Log transaction
    await tx.transaction.create({
      data: {
        userId:      bounty.creatorId,
        type:        'CREATOR_BOUNTY',
        amountKes:   payoutKes,
        balAfter:    Number(updated.balanceKes),
        status:      'PENDING',
        description: `Creator bounty — "${bounty.market.title.slice(0, 60)}"`,
      },
    });
  });

  // Paystack transfer to creator's phone
const recipient = await createTransferRecipient({
  name:     bounty.creator.name ?? bounty.creator.phone,
  phone:    formatPhone(bounty.creator.phone),
  bankCode: 'MPesa',
});
await initiateTransfer({
  amountKes:     payoutKes,
  recipientCode: recipient.recipient_code,
  reference:     `CKR-BNT-${bounty.marketId.slice(0,8).toUpperCase()}`,
  reason:        'CheckRada Creator Bounty',
});

  await logAdminAction(admin.id, 'BOUNTY_PAID', `bounty:${bountyId}`, {
    creatorPhone: bounty.creator.phone,
    amountKes: payoutKes,
  }, req);

  return NextResponse.json({ success: true, paidKes: payoutKes });
}
