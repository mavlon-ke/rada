// src/app/api/admin/markets/[marketId]/resolve/route.ts
//
// Payout model:
//   realPoolBalance   = market.totalVolume  (actual KES collected net of fees)
//   platformCut       = floor(realPoolBalance × resolutionCutRate)  [from PlatformConfig]
//   distributable     = realPoolBalance − platformCut
//   payoutPerShare    = distributable / totalWinningShares
//   each winner gets  = floor(shares × payoutPerShare)
//   marketSurplus     = realPoolBalance − totalPayouts  (includes cut + floor dust)
//
// This guarantees: totalPayouts < realPoolBalance < grossDeposits — always solvent.
// Works correctly for balanced, unbalanced, and unanimous (all one side) markets.

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
  // realPoolBalance = actual KES collected net of fees (stored in totalVolume)
  const realPoolBalance     = Number(market.totalVolume);
  const platformCut         = Math.floor(realPoolBalance * resolutionCutRate);
  const distributable       = realPoolBalance - platformCut;
  const totalWinningShares  = winningPositions.reduce((s, p) => s + Number(p.shares), 0);

  // payoutPerShare: distributable divided across all winning shares
  // If no winning positions (impossible if market is valid, but guard anyway):
  const payoutPerShare = totalWinningShares > 0 ? distributable / totalWinningShares : 0;

  // isUnanimous: true when only one side has any bettors
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
  // - Forecasting fees: recorded from Order.forecastingFeeKes (collected at trade time)
  // - Market surplus:   realPoolBalance − totalPayouts (includes cut + floor dust)
  //   Note: do NOT subtract fees here — totalVolume is already net of fees.
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
            + `Resolution cut: ${(resolutionCutRate * 100).toFixed(1)}%.`,
        },
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

    // 4. Market surplus revenue record (resolution cut + floor dust)
    if (marketSurplus > 0) {
      await tx.platformRevenue.create({
        data: {
          marketId:    market.id,
          type:        'MARKET_SURPLUS',
          amountKes:   marketSurplus,
          description: `Market surplus — ${market.title.slice(0, 80)}. `
            + `Resolution cut (${(resolutionCutRate * 100).toFixed(1)}%): KES ${platformCut}. `
            + `Floor dust: KES ${marketSurplus - platformCut}.`,
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
    `Pool: KES ${realPoolBalance}, Cut: KES ${platformCut} (${(resolutionCutRate*100).toFixed(1)}%), ` +
    `Distributable: KES ${distributable}, Payouts: KES ${totalPayouts}, Surplus: KES ${marketSurplus}. ` +
    `Winners: ${payouts.length}, Losers: ${losingPositions.length}.`
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
    success:        true,
    outcome,
    marketId:       market.id,
    isUnanimous,
    poolKes:        realPoolBalance,
    platformCutKes: platformCut,
    distributedKes: distributable,
    payoutPerShare: parseFloat(payoutPerShare.toFixed(6)),
    winnersCount:   payouts.length,
    totalPayoutKes: totalPayouts,
    platformRevenue: {
      forecastingFees: totalFeesCollected,
      marketSurplus,
      total:           totalFeesCollected + marketSurplus,
    },
  });
}
