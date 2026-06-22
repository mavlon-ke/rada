// src/app/api/admin/markets/[marketId]/resolve/route.ts
//
// Payout model:
//   realPoolBalance   = market.totalVolume  (actual KES collected net of fees)
//   loserNetStakes    = SUM(netAmountKes) for orders on the LOSING side
//   platformCut       = floor(loserNetStakes × resolutionCutRate)  [from PlatformConfig]
//   distributable     = realPoolBalance − platformCut
//   payoutPerShare    = distributable / totalWinningShares
//   each winner gets  = floor(shares × payoutPerShare)
//   marketSurplus     = realPoolBalance − totalPayouts  (cut + floor dust)
//
// WHY cut only from loser stakes:
//   The resolution cut is a fee on money that changes hands — loser contributions.
//   Cutting from the entire pool taxes winner principal, causing correct bettors to
//   lose their own money in lopsided markets. With this formula, the only guaranteed
//   cost to a winner is the 5% forecasting fee agreed at trade time.
//   Unanimous markets: loserNetStakes = 0 → platformCut = 0 → winners get full net stakes back.
//
// This guarantees: totalPayouts < realPoolBalance < grossDeposits — always solvent.
// Works correctly for balanced, unbalanced, and unanimous markets.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';
import { createNotification } from '@/lib/notifications';

const DEFAULT_RESOLUTION_CUT_RATE   = 0.20;  // fallback if PlatformConfig missing
const DEFAULT_FORECASTING_FEE_RATE  = 0.05;

const Schema = z.object({
  outcome:    z.enum(['YES', 'NO']),
  sourceNote: z.string().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { marketId: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const body   = await req.json();
  const parsed = Schema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { outcome, sourceNote } = parsed.data;
  const losingSide = outcome === 'YES' ? 'NO' : 'YES';

  // ── Dynamic rates from PlatformConfig ────────────────────────────────────
  const platformConfig = await prisma.platformConfig.findUnique({ where: { id: 'singleton' } });
  const resolutionCutRate = platformConfig
    ? Number(platformConfig.resolutionCutRate)
    : DEFAULT_RESOLUTION_CUT_RATE;
  const forecastingFeeRate = platformConfig
    ? Number(platformConfig.forecastingFeeRate)
    : DEFAULT_FORECASTING_FEE_RATE;

  // ── Fetch market with all positions ──────────────────────────────────────
  const market = await prisma.market.findUnique({
    where:   { id: params.marketId },
    include: {
      positions: {
        where:   { shares: { gt: 0 } },
        include: { user: { select: { id: true, phone: true } } },
      },
    },
  });

  if (!market)
    return NextResponse.json({ error: 'Market not found' }, { status: 404 });
  if (market.status !== 'CLOSED')
    return NextResponse.json({ error: 'Market must be CLOSED to resolve' }, { status: 400 });
  if (market.outcome)
    return NextResponse.json({ error: 'Market already resolved' }, { status: 400 });

  const winningPositions = market.positions.filter(p => p.side === outcome);
  const losingPositions  = market.positions.filter(p => p.side === losingSide);

  // ── Pool and payout calculation ───────────────────────────────────────────
  const realPoolBalance = Number(market.totalVolume);

  // ── Loser net stakes — platform cut source ────────────────────────────────
  // Platform cut comes ONLY from loser net stakes, never from winner principal.
  // Queried from orders (not positions) because orders store the original netAmountKes.
  const loserAgg = await prisma.order.aggregate({
    where: { marketId: market.id, side: losingSide },
    _sum:  { netAmountKes: true },
  });
  const loserNetStakes = Number(loserAgg._sum.netAmountKes ?? 0);
  const platformCut    = Math.floor(loserNetStakes * resolutionCutRate);
  const distributable  = realPoolBalance - platformCut;

  const totalWinningShares = winningPositions.reduce((s, p) => s + Number(p.shares), 0);

  const payoutPerShare = totalWinningShares > 0 ? distributable / totalWinningShares : 0;

  // isUnanimous: all stakes on one side — loserNetStakes will be 0, cut = 0
  const hasYesBettors = market.positions.some(p => p.side === 'YES');
  const hasNoBettors  = market.positions.some(p => p.side === 'NO');
  const isUnanimous   = !hasYesBettors || !hasNoBettors;

  const payouts = winningPositions.map(p => ({
    userId:     p.userId,
    netKes:     Math.floor(Number(p.shares) * payoutPerShare),
    shares:     Number(p.shares),
    positionId: p.id,
  })).filter(p => p.netKes >= 1);

  const totalPayouts = payouts.reduce((s, p) => s + p.netKes, 0);

  // Platform revenue breakdown:
  // - Forecasting fees: collected at trade time (Order.forecastingFeeKes)
  // - Market surplus:   platformCut (from loser stakes) + floor rounding dust
  const ordersAgg = await prisma.order.aggregate({
    where: { marketId: market.id },
    _sum:  { forecastingFeeKes: true },
  });
  const totalFeesCollected = Math.floor(Number(ordersAgg._sum.forecastingFeeKes ?? 0));
  const marketSurplus      = Math.max(0, realPoolBalance - totalPayouts);

  // ── Atomic resolution transaction ────────────────────────────────────────
  await prisma.$transaction(async (tx) => {
    // 1. Mark market resolved
    await tx.market.update({
      where: { id: market.id },
      data: {
        status:     'RESOLVED',
        outcome,
        resolvedAt: new Date(),
        ...(sourceNote ? { sourceNote } : {}),
      },
    });

    // 2. Credit winners
    for (const p of payouts) {
      const updated = await tx.user.update({
        where: { id: p.userId },
        data:  { balanceKes: { increment: p.netKes } },
      });
      await tx.transaction.create({
        data: {
          userId:      p.userId,
          type:        'PAYOUT',
          amountKes:   p.netKes,
          balAfter:    Number(updated.balanceKes),
          status:      'SUCCESS',
          description: `Market payout (${outcome}) — ${market.title.slice(0, 80)}. `
            + `${p.shares.toFixed(4)} shares × KES ${payoutPerShare.toFixed(4)}/share. `
            + `Resolution cut: ${(resolutionCutRate * 100).toFixed(1)}% of loser stakes `
            + `(KES ${loserNetStakes}).`,
        },
      });
      // Update realizedPnl on the position
      await tx.position.update({
        where: { id: p.positionId },
        data:  { realizedPnl: p.netKes },
      });
    }

    // 3. Forecasting fees revenue record
    if (totalFeesCollected > 0) {
      await tx.platformRevenue.create({
        data: {
          marketId:    market.id,
          type:        'FORECASTING_FEE',
          amountKes:   totalFeesCollected,
          description: `Forecasting fees (${(forecastingFeeRate * 100).toFixed(1)}%) — ${market.title.slice(0, 80)}.`,
        },
      });
    }

    // 4. Market surplus = resolution cut (from loser stakes) + floor rounding dust
    if (marketSurplus > 0) {
      await tx.platformRevenue.create({
        data: {
          marketId:    market.id,
          type:        'MARKET_SURPLUS',
          amountKes:   marketSurplus,
          description: `Market surplus — ${market.title.slice(0, 80)}. `
            + `Resolution cut (${(resolutionCutRate * 100).toFixed(1)}% of loser KES ${loserNetStakes}): KES ${platformCut}. `
            + `Floor dust: KES ${marketSurplus - platformCut}.`,
        },
      });
    }

    // 4b. Creator royalty — deferred from per-trade to resolve time (Option B).
    //     bountyEarned accumulated per-trade as a live counter.
    //     At resolve: pay the full accumulated amount, book the PlatformRevenue offset.
    //     Guard: paidOut === 0 ensures idempotency — safe to call twice.
    const bounty = await tx.creatorBounty.findUnique({
      where:  { marketId: market.id },
      select: { bountyEarned: true, creatorId: true, paidOut: true },
    });
    let creatorRoyaltyPaid = 0;
    if (bounty && bounty.creatorId && Number(bounty.bountyEarned) >= 1 && Number(bounty.paidOut) === 0) {
      creatorRoyaltyPaid = Number(bounty.bountyEarned);

      const updatedCreator = await tx.user.update({
        where: { id: bounty.creatorId },
        data:  { balanceKes: { increment: creatorRoyaltyPaid } },
      });

      await tx.transaction.create({
        data: {
          userId:      bounty.creatorId,
          type:        'CREATOR_BOUNTY',
          amountKes:   creatorRoyaltyPaid,
          balAfter:    Number(updatedCreator.balanceKes),
          status:      'SUCCESS',
          description: `Creator royalty paid at resolution — "${market.title.slice(0, 80)}". `
            + `KES ${creatorRoyaltyPaid} earned from KES ${Math.round(Number(market.totalVolume))} volume.`,
        },
      });

      await tx.creatorBounty.update({
        where: { marketId: market.id },
        data:  { paidOut: creatorRoyaltyPaid, lastPaidAt: new Date() },
      });

      // Negative PlatformRevenue offset — royalty is carved out of forecasting fees.
      // Both this and FORECASTING_FEE are booked atomically here at resolve time.
      await tx.platformRevenue.create({
        data: {
          marketId:    market.id,
          type:        'CREATOR_ROYALTY_PAID',
          amountKes:   -creatorRoyaltyPaid,
          description: `Creator royalty paid at resolution — "${market.title.slice(0, 80)}". `
            + `Offsets FORECASTING_FEE. KES ${creatorRoyaltyPaid}.`,
        },
      });
    }

    // 5. Deactivate creator bounty
    await tx.creatorBounty.updateMany({
      where: { marketId: market.id, active: true },
      data:  { active: false, deactivatedAt: new Date() },
    });
  });

  console.log(
    `[RESOLVE] ${market.id} → ${outcome}. ` +
    `Pool: KES ${realPoolBalance}, Loser stakes: KES ${loserNetStakes}, ` +
    `Cut: KES ${platformCut} (${(resolutionCutRate*100).toFixed(1)}% of losers), ` +
    `Distributable: KES ${distributable}, Payouts: KES ${totalPayouts}, ` +
    `Surplus: KES ${marketSurplus}. ` +
    `Winners: ${payouts.length}, Losers: ${losingPositions.length}. ` +
    `Creator royalty: KES ${creatorRoyaltyPaid}.`
  );

  // ── Notifications (fire-and-forget, outside transaction) ─────────────────
  const titleShort   = market.title.length > 80 ? market.title.slice(0, 77) + '...' : market.title;
  const outcomeLabel = outcome;

  for (const p of payouts) {
    void createNotification({
      userId:  p.userId,
      type:    'MARKET_RESOLVED',
      title:   `🎉 You won KES ${p.netKes.toLocaleString()}`,
      message: `Market resolved ${outcomeLabel}: "${titleShort}". Winnings credited to your wallet.`,
      link:    '/rada-dashboard.html',
      whatsapp: { template: 'MARKET_RESOLVED_WON', parameters: [p.netKes.toLocaleString()] },
    });
  }
  for (const p of losingPositions) {
    void createNotification({
      userId:  p.userId,
      type:    'MARKET_RESOLVED',
      title:   `Market resolved ${outcomeLabel}`,
      message: `"${titleShort}" resolved ${outcomeLabel}. Better luck next time.`,
      link:    '/rada-markets.html',
      whatsapp: { template: 'MARKET_RESOLVED_LOST', parameters: [] },
    });
  }

  return NextResponse.json({
    success:         true,
    outcome,
    marketId:        market.id,
    isUnanimous,
    poolKes:         realPoolBalance,
    loserNetStakes,
    platformCutKes:  platformCut,
    distributedKes:  distributable,
    payoutPerShare:  parseFloat(payoutPerShare.toFixed(6)),
    winnersCount:    payouts.length,
    totalPayoutKes:  totalPayouts,
    platformRevenue: {
      forecastingFees:  totalFeesCollected,
      marketSurplus,
      creatorRoyalty:   creatorRoyaltyPaid,
      total:            totalFeesCollected + marketSurplus - creatorRoyaltyPaid,
    },
  });
}
