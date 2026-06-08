// src/app/api/admin/markets/[marketId]/unresolve/route.ts
// Reverses a wrongly-resolved market.
//
// What this does (inverse of /resolve):
//   1. Claws back each winner's payout from their current wallet balance.
//      If a winner has already withdrawn some/all of their payout, we take
//      what's available and flag the shortfall — we cannot reclaim real
//      M-Pesa money that has already left the platform.
//   2. Creates a REFUND transaction record for each clawback to keep the
//      ledger consistent.
//   3. Deletes the PlatformRevenue records tied to this market resolution
//      (FORECASTING_FEE and MARKET_SURPLUS rows).
//   4. Reactivates the creator bounty if it was deactivated at resolution.
//   5. Resets the market to CLOSED — it can then be re-resolved correctly.
//      Status goes back to CLOSED (not OPEN) because the event has already
//      happened; the market just needs to be re-resolved with the right outcome.
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

  // ── Dynamic rate — must match resolve route exactly ─────────────────────
  const platformConfig    = await prisma.platformConfig.findUnique({ where: { id: 'singleton' } });
  const resolutionCutRate = platformConfig ? Number(platformConfig.resolutionCutRate) : 0.20;

  // ── Identify winning positions (same logic as /resolve) ─────────────────
  const winningPositions   = market.positions.filter(p => p.side === originalOutcome);

  // ── Recompute payoutPerShare using same formula as /resolve ───────────────
  // realPoolBalance = totalVolume (actual KES net of fees)
  // distributable   = realPoolBalance × (1 − resolutionCutRate)
  // payoutPerShare  = distributable / totalWinningShares
  const realPoolBalance    = Number(market.totalVolume);
  const platformCut        = Math.floor(realPoolBalance * resolutionCutRate);
  const distributable      = realPoolBalance - platformCut;
  const totalWinningShares = winningPositions.reduce((s, p) => s + Number(p.shares), 0);
  const payoutPerShare     = totalWinningShares > 0 ? distributable / totalWinningShares : 0;

  const clawbacks = winningPositions
    .map(p => ({
      userId:     p.userId,
      phone:      p.user?.phone ?? '',
      name:       p.user?.name ?? 'User',
      paidKes:    Math.floor(Number(p.shares) * payoutPerShare),
      positionId: p.id,
    }))
    .filter(c => c.paidKes >= 1);

  // ── Atomic reversal ──────────────────────────────────────────────────────
  const clawbackResults = await prisma.$transaction(async (tx) => {
    const results: Array<{
      userId:     string;
      phone:      string;
      paidKes:    number;
      clawedKes:  number;
      shortfall:  number;
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

      results.push({ userId: c.userId, phone: c.phone, paidKes: c.paidKes, clawedKes, shortfall });
    }

    // 2. Delete platform revenue records tied to this market resolution
    await tx.platformRevenue.deleteMany({
      where: { marketId: market.id },
    });

    // 3. Reactivate creator bounty
    await tx.creatorBounty.updateMany({
      where: { marketId: market.id, active: false },
      data:  { active: true, deactivatedAt: null },
    });

    // 4. Reset market to CLOSED — ready for correct re-resolution
    await tx.market.update({
      where: { id: market.id },
      data: { status: 'CLOSED', outcome: null, resolvedAt: null },
    });

    return results;
  });

  // ── Summarise clawback results ───────────────────────────────────────────
  const totalPaidOut    = clawbackResults.reduce((s, r) => s + r.paidKes,   0);
  const totalClawed     = clawbackResults.reduce((s, r) => s + r.clawedKes, 0);
  const totalShortfall  = clawbackResults.reduce((s, r) => s + r.shortfall,  0);
  const partialClawbacks = clawbackResults.filter(r => r.shortfall > 0);

  console.log(
    `[UNRESOLVE] Market ${market.id} ("${market.title.slice(0, 60)}") reversed from ${originalOutcome}. ` +
    `Clawbacks: ${clawbacks.length}. Clawed: KES ${totalClawed}. Shortfall: KES ${totalShortfall}.`
  );

  // ── Log admin activity ───────────────────────────────────────────────────
  await logAdminAction(
    admin.id,
    'MARKET_UNRESOLVED',
    market.id,
    {
      originalOutcome,
      title:          market.title,
      clawbackCount:  clawbacks.length,
      totalPaidOut,
      totalClawed,
      totalShortfall,
      partialUsers:   partialClawbacks.map(r => r.phone),
    },
    req
  );

  // ── Post-commit: notify all affected users (fire-and-forget) ────────────
  // Winners: tell them their payout was reversed and the market will be re-resolved.
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
  // Losers (positions on the losing side) also had a loss notification sent at resolution.
  // Notify them too so they know the outcome is under review.
  const losingPositions = market.positions.filter(p => p.side !== originalOutcome);
  for (const p of losingPositions) {
    if (clawbackResults.some(c => c.userId === p.userId)) continue; // already notified above
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
