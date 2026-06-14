// src/app/api/admin/markets/[marketId]/unresolve/route.ts
// Reverses a wrongly-resolved market.
//
// What this does (inverse of /resolve):
//   1. Claws back each winner's payout using position.realizedPnl — the exact
//      amount credited at resolution. This is correct regardless of any formula
//      changes between resolution and reversal.
//      Fallback: if realizedPnl is 0 (pre-fix positions), recompute using the
//      current resolve formula (loserNetStakes × resolutionCutRate).
//   2. Creates a REFUND transaction record for each clawback.
//   3. Deletes the PlatformRevenue records tied to this market resolution.
//   4. Reactivates the creator bounty if it was deactivated at resolution.
//   5. Resets the market to CLOSED — ready for correct re-resolution.
//
// Idempotency: guards against running on a market that is not RESOLVED.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';
import { createNotification } from '@/lib/notifications';

export async function POST(
  req: NextRequest,
  { params }: { params: { marketId: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  // ── Fetch market with winning positions ─────────────────────────────────
  const market = await prisma.market.findUnique({
    where: { id: params.marketId },
    include: {
      positions: {
        where: { shares: { gt: 0 } },
        include: { user: { select: { id: true, name: true, phone: true } } },
      },
    },
  });

  if (!market) {
    return NextResponse.json({ error: 'Market not found' }, { status: 404 });
  }
  if (market.status !== 'RESOLVED') {
    return NextResponse.json({ error: 'Market is not resolved — nothing to reverse.' }, { status: 400 });
  }
  if (!market.outcome) {
    return NextResponse.json({ error: 'Market has no recorded outcome — data inconsistency.' }, { status: 400 });
  }

  const originalOutcome = market.outcome;
  const losingSide      = originalOutcome === 'YES' ? 'NO' : 'YES';

  // ── Winning positions ────────────────────────────────────────────────────
  const winningPositions = market.positions.filter(p => p.side === originalOutcome);

  // ── Fallback formula (mirrors fixed resolve route) ───────────────────────
  // Used only when position.realizedPnl = 0 (positions resolved before the fix).
  const platformConfig = await prisma.platformConfig.findUnique({ where: { id: 'singleton' } });
  const resolutionCutRate = platformConfig ? Number(platformConfig.resolutionCutRate) : 0.20;

  const loserAgg = await prisma.order.aggregate({
    where: { marketId: market.id, side: losingSide },
    _sum:  { netAmountKes: true },
  });
  const loserNetStakes     = Number(loserAgg._sum.netAmountKes ?? 0);
  const platformCut        = Math.floor(loserNetStakes * resolutionCutRate);
  const realPoolBalance    = Number(market.totalVolume);
  const distributable      = realPoolBalance - platformCut;
  const totalWinningShares = winningPositions.reduce((s, p) => s + Number(p.shares), 0);
  const payoutPerShare     = totalWinningShares > 0 ? distributable / totalWinningShares : 0;

  // ── Build clawbacks ──────────────────────────────────────────────────────
  // Primary:  use realizedPnl (exact amount credited at resolution).
  // Fallback: recompute with current formula if realizedPnl is 0.
  const clawbacks = winningPositions
    .map(p => {
      const realizedPnl = Number(p.realizedPnl);
      const paidKes = realizedPnl > 0
        ? realizedPnl
        : Math.floor(Number(p.shares) * payoutPerShare);
      return {
        userId:     p.userId,
        phone:      p.user?.phone ?? '',
        name:       p.user?.name ?? 'User',
        paidKes,
        positionId: p.id,
      };
    })
    .filter(c => c.paidKes >= 1);

  // ── Atomic reversal ──────────────────────────────────────────────────────
  const clawbackResults = await prisma.$transaction(async (tx) => {
    const results: Array<{
      userId:    string;
      phone:     string;
      paidKes:   number;
      clawedKes: number;
      shortfall: number;
    }> = [];

    // 1. Clawback each winner
    for (const c of clawbacks) {
      const freshUser = await tx.user.findUnique({
        where:  { id: c.userId },
        select: { balanceKes: true },
      });

      const currentBal = Number(freshUser?.balanceKes ?? 0);
      const clawedKes  = Math.min(c.paidKes, Math.max(0, currentBal));
      const shortfall  = c.paidKes - clawedKes;

      if (clawedKes > 0) {
        const updated = await tx.user.update({
          where: { id: c.userId },
          data:  { balanceKes: { decrement: clawedKes } },
        });

        await tx.transaction.create({
          data: {
            userId:      c.userId,
            type:        'REFUND',
            amountKes:   -clawedKes,
            balAfter:    Number(updated.balanceKes),
            status:      'SUCCESS',
            description: `Resolution reversal — payout of KES ${c.paidKes} clawed back for "${market.title.slice(0, 80)}". Original outcome: ${originalOutcome}.`,
          },
        });
      }

      // Reset realizedPnl — position is no longer resolved
      await tx.position.update({
        where: { id: c.positionId },
        data:  { realizedPnl: 0 },
      });

      results.push({ userId: c.userId, phone: c.phone, paidKes: c.paidKes, clawedKes, shortfall });
    }

    // 2. Delete platform revenue records for this resolution
    await tx.platformRevenue.deleteMany({
      where: { marketId: market.id },
    });

    // 3. Reactivate creator bounty
    await tx.creatorBounty.updateMany({
      where: { marketId: market.id, active: false },
      data:  { active: true, deactivatedAt: null },
    });

    // 4. Reset market to CLOSED
    await tx.market.update({
      where: { id: market.id },
      data:  { status: 'CLOSED', outcome: null, resolvedAt: null },
    });

    return results;
  });

  // ── Summarise ────────────────────────────────────────────────────────────
  const totalPaidOut     = clawbackResults.reduce((s, r) => s + r.paidKes,   0);
  const totalClawed      = clawbackResults.reduce((s, r) => s + r.clawedKes, 0);
  const totalShortfall   = clawbackResults.reduce((s, r) => s + r.shortfall,  0);
  const partialClawbacks = clawbackResults.filter(r => r.shortfall > 0);

  console.log(
    `[UNRESOLVE] Market ${market.id} ("${market.title.slice(0, 60)}") reversed from ${originalOutcome}. ` +
    `Clawbacks: ${clawbacks.length}. Clawed: KES ${totalClawed}. Shortfall: KES ${totalShortfall}.`
  );

  await logAdminAction(
    admin.id,
    'MARKET_UNRESOLVED',
    market.id,
    {
      originalOutcome,
      title:         market.title,
      clawbackCount: clawbacks.length,
      totalPaidOut,
      totalClawed,
      totalShortfall,
      partialUsers:  partialClawbacks.map(r => r.phone),
    },
    req
  );

  // ── Notify affected users (fire-and-forget) ───────────────────────────
  for (const c of clawbackResults) {
    void createNotification({
      userId:  c.userId,
      type:    'MARKET_RESOLVED',
      title:   '⚠ Market resolution reversed',
      message: `The resolution of "${market.title.slice(0, 80)}" has been corrected by the admin. ` +
               `KES ${c.clawedKes.toLocaleString()} has been adjusted from your wallet. ` +
               (c.shortfall > 0
                 ? `KES ${c.shortfall.toLocaleString()} could not be recovered as it had already been withdrawn.`
                 : 'The market will be re-resolved with the correct outcome shortly.'),
      link: '/rada-portfolio.html',
    });
  }

  const losingPositions = market.positions.filter(p => p.side !== originalOutcome);
  for (const p of losingPositions) {
    if (clawbackResults.some(c => c.userId === p.userId)) continue;
    void createNotification({
      userId:  p.userId,
      type:    'MARKET_RESOLVED',
      title:   '⚠ Market resolution reversed',
      message: `The resolution of "${market.title.slice(0, 80)}" has been corrected. ` +
               'The market will be re-resolved with the correct outcome shortly.',
      link: '/rada-markets.html',
    });
  }

  return NextResponse.json({
    success:         true,
    marketId:        market.id,
    originalOutcome,
    newStatus:       'CLOSED',
    message:         `Market reversed to CLOSED. ${clawbacks.length} payout(s) clawed back. Re-resolve with the correct outcome.`,
    clawbackSummary: {
      count:        clawbacks.length,
      totalPaidOut,
      totalClawed,
      totalShortfall,
    },
    ...(partialClawbacks.length > 0 && {
      warning: `${partialClawbacks.length} user(s) had insufficient balance — partial clawback only. KES ${totalShortfall} could not be recovered (funds already withdrawn).`,
      partialClawbacks: partialClawbacks.map(r => ({
        phone:     r.phone,
        paidKes:   r.paidKes,
        clawedKes: r.clawedKes,
        shortfall: r.shortfall,
      })),
    }),
  });
}
