import { withErrorHandling } from '@/lib/security/route-guard';
// src/app/api/admin/bounties/route.ts
// GET  — list all creator bounties with unpaid balance
// POST — trigger M-Pesa payout to a creator

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';



// Fallback minimum payout if PlatformConfig.bountyMinPayoutKes is missing (singleton row deleted).
// The admin-tunable value lives in platform_config; this constant is just a safety net.
const BOUNTY_MIN_PAYOUT_FALLBACK = 100;

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const bounties = await prisma.creatorBounty.findMany({
    // No active filter — show all bounties including those on resolved/cancelled
    // markets. The active flag is set to false at resolution, which was causing
    // earned royalties to disappear from the ledger.
    include: {
      creator: { select: { phone: true, name: true } },
      market:  { select: { title: true, totalVolume: true, status: true } },
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

  // Read tunable minimum payout from PlatformConfig.
  const platformConfig = await prisma.platformConfig.findUnique({ where: { id: 'singleton' } });
  const bountyMinPayout = platformConfig
    ? Number(platformConfig.bountyMinPayoutKes)
    : BOUNTY_MIN_PAYOUT_FALLBACK;

  const unpaid = Number(bounty.bountyEarned) - Number(bounty.paidOut);
  if (unpaid < bountyMinPayout) {
    return NextResponse.json({
      error: `Unpaid balance KES ${unpaid.toFixed(2)} is below minimum payout threshold of KES ${bountyMinPayout}`,
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

    // Log transaction — bounty credited to wallet; creator withdraws via standard flow
    await tx.transaction.create({
      data: {
        userId:      bounty.creatorId,
        type:        'CREATOR_BOUNTY',
        amountKes:   payoutKes,
        balAfter:    Number(updated.balanceKes),
        status:      'SUCCESS',
        description: `Creator bounty credited to wallet — "${bounty.market.title.slice(0, 60)}"`,
      },
    });
  });
  // Bounty credited to wallet — creator withdraws via the standard withdrawal flow.
  // Direct M-Pesa transfer removed: it was double-paying (wallet credit + live transfer
  // for the same amount). Withdrawal flow handles reconciliation correctly.

  await logAdminAction(admin.id, 'BOUNTY_PAID', `bounty:${bountyId}`, {
    creatorPhone: bounty.creator.phone,
    amountKes: payoutKes,
  }, req);

  return NextResponse.json({ success: true, paidKes: payoutKes });
}
