// src/app/api/admin/markets/[marketId]/status/route.ts
// PAUSE: moves market OPEN → CLOSED so admin can then Resolve or Void it.
// VOID (CANCEL): full refund of gross stake (including trading fee) to all
//   participants. Sets status to CANCELLED. No revenue is recognised.
//
// Void guarantees:
//   - Server-side status guard: RESOLVED and CANCELLED markets are rejected.
//   - Full refund: uses Order.amountKes (gross) not Position.shares × avgPrice (net).
//   - Bonus split: real money returned to balanceKes, bonus to bonusBalanceKes.
//   - Creator bounty reset: bountyEarned and paidOut both zeroed (nothing was paid).
//   - Notifications: every refunded user receives in-app + WhatsApp alert.
//   - Reason captured in every refund transaction description and notification.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';
import { createNotification } from '@/lib/notifications';

const Schema = z.object({
  action: z.enum(['PAUSE', 'CANCEL']),
  reason: z.string().max(300).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { marketId: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const body   = await req.json();
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { action, reason } = parsed.data;

  const market = await prisma.market.findUnique({ where: { id: params.marketId } });
  if (!market) return NextResponse.json({ error: 'Market not found' }, { status: 404 });

  // ── PAUSE ─────────────────────────────────────────────────────────────────
  if (action === 'PAUSE') {
    await prisma.market.update({
      where: { id: params.marketId },
      data:  { status: 'CLOSED' },
    });
    return NextResponse.json({ success: true, action: 'PAUSED' });
  }

  // ── VOID (CANCEL) ─────────────────────────────────────────────────────────
  if (action === 'CANCEL') {

    // Server-side status guard — prevents double-refund after resolution
    if (market.status === 'RESOLVED') {
      return NextResponse.json({
        error: 'Cannot void a RESOLVED market. Unresolve it first if you need to cancel.',
      }, { status: 400 });
    }
    if (market.status === 'CANCELLED') {
      return NextResponse.json({
        error: 'Market is already voided.',
      }, { status: 400 });
    }

    const voidReason = reason?.trim() || 'Admin decision';

    // ── Full gross refund from Order records ─────────────────────────────────
    // Position.avgPrice is the cost per share on the NET amount (after fee),
    // so shares × avgPrice = net stake, not gross. We must use Order.amountKes
    // to return the full amount including the 5% forecasting fee.
    // Bonus is split back correctly: real → balanceKes, bonus → bonusBalanceKes.
    const orders = await prisma.order.findMany({
      where:  { marketId: params.marketId },
      select: { userId: true, amountKes: true, bonusUsedKes: true },
    });

    // Group by userId — a user may have made multiple trades
    const refundMap = new Map<string, { gross: number; bonus: number }>();
    for (const o of orders) {
      if (!o.userId) continue;
      const existing = refundMap.get(o.userId) ?? { gross: 0, bonus: 0 };
      refundMap.set(o.userId, {
        gross: existing.gross + Number(o.amountKes),
        bonus: existing.bonus + Number(o.bonusUsedKes),
      });
    }

    // Positions to zero out
    const positions = await prisma.position.findMany({
      where:  { marketId: params.marketId, shares: { gt: 0 } },
      select: { id: true },
    });

    // Creator bounty — nothing was paid (market never resolved under Option B)
    const bounty = await prisma.creatorBounty.findUnique({
      where:  { marketId: params.marketId },
      select: { id: true, paidOut: true },
    });

    // ── Atomic transaction ────────────────────────────────────────────────────
    await prisma.$transaction(async (tx) => {

      // 1. Mark market as CANCELLED
      await tx.market.update({
        where: { id: params.marketId },
        data:  { status: 'CANCELLED' },
      });

      // 2. Full refund to each user
      for (const [userId, refund] of Array.from(refundMap.entries())) {
        const realRefund  = refund.gross - refund.bonus;  // return to main balance
        const bonusRefund = refund.bonus;                  // return to bonus balance

        const updatedUser = await tx.user.update({
          where: { id: userId },
          data: {
            ...(realRefund  > 0 ? { balanceKes:      { increment: realRefund  } } : {}),
            ...(bonusRefund > 0 ? { bonusBalanceKes: { increment: bonusRefund } } : {}),
          },
        });

        await tx.transaction.create({
          data: {
            userId,
            type:        'REFUND',
            amountKes:   refund.gross,
            balAfter:    Number(updatedUser.balanceKes),
            status:      'SUCCESS',
            description: `Full refund — market voided: "${market.title.slice(0, 80)}". `
              + `KES ${refund.gross} returned (incl. trading fee).`
              + (bonusRefund > 0 ? ` KES ${bonusRefund} returned to bonus balance.` : '')
              + ` Reason: ${voidReason}.`,
          },
        });
      }

      // 3. Zero out all positions
      if (positions.length > 0) {
        await tx.position.updateMany({
          where: { marketId: params.marketId, shares: { gt: 0 } },
          data:  { shares: 0 },
        });
      }

      // 4. Reset creator bounty — nothing owed, nothing to claw back
      //    Under Option B, paidOut = 0 for all unresolved markets (royalty
      //    is only paid at resolve time). bountyEarned is zeroed since this
      //    market generated no real earnings.
      if (bounty) {
        await tx.creatorBounty.update({
          where: { marketId: params.marketId },
          data: {
            active:        false,
            deactivatedAt: new Date(),
            bountyEarned:  0,
            paidOut:       0,
          },
        });
      }

      // 5. Cleanup: delete any stale PlatformRevenue rows
      //    (shouldn't exist for an unresolved market, but defensive cleanup)
      await tx.platformRevenue.deleteMany({
        where: { marketId: params.marketId },
      });
    });

    // ── Notifications (fire-and-forget, outside transaction) ─────────────────
    const titleShort = market.title.length > 80
      ? market.title.slice(0, 77) + '...'
      : market.title;

    for (const [userId, refund] of Array.from(refundMap.entries())) {
      void createNotification({
        userId,
        type:    'MARKET_RESOLVED',
        title:   '↩ Market voided — full refund',
        message: `"${titleShort}" has been voided. `
          + `Your full stake of KES ${refund.gross.toLocaleString()} has been refunded to your wallet. `
          + `Reason: ${voidReason}.`,
        link: '/rada-portfolio.html',
      });
    }

    console.log(
      `[VOID] Market ${params.marketId} ("${market.title.slice(0, 60)}") voided by admin. ` +
      `${refundMap.size} users refunded. Reason: ${voidReason}.`
    );

    return NextResponse.json({
      success:       true,
      action:        'CANCELLED',
      refundedUsers: refundMap.size,
      reason:        voidReason,
    });
  }
}
