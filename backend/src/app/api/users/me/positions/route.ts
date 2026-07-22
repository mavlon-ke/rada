// src/app/api/users/me/positions/route.ts
// Returns two arrays:
//   positions       — active open positions (shares > 0, market not CANCELLED)
//   voidedPositions — positions on voided markets, shown in My Forecasts with VOIDED badge
//
// Uses only plain arrays and objects (no Map/Set iteration) to stay compatible
// with this project's TypeScript target (no explicit target → defaults to ES3).

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { getYesPrice } from '@/lib/market/amm';
import { withErrorHandling } from '@/lib/security/route-guard';

export const GET = withErrorHandling(async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // ── Active positions ───────────────────────────────────────────────────────
  const positions = await prisma.position.findMany({
    where: {
      userId: user.id,
      shares: { gt: 0 },
      market: { status: { not: 'CANCELLED' } },
    },
    include: { market: true },
    orderBy: { updatedAt: 'desc' },
  });

  const enriched = positions.map(p => {
    const yesPrice      = getYesPrice(Number(p.market.yesPool), Number(p.market.noPool));
    const currentProb   = p.side === 'YES' ? yesPrice : 1 - yesPrice;
    const currentValue  = Number(p.shares) * currentProb;
    const costBasis     = Number(p.shares) * Number(p.avgPrice);
    const unrealizedPnl = currentValue - costBasis;

    return {
      ...p,
      shares:        Number(p.shares),
      avgPrice:      Number(p.avgPrice),
      realizedPnl:   Number(p.realizedPnl),
      currentValue:  parseFloat(currentValue.toFixed(2)),
      unrealizedPnl: parseFloat(unrealizedPnl.toFixed(2)),
      market: {
        ...p.market,
        yesPrice: parseFloat(yesPrice.toFixed(4)),
        noPrice:  parseFloat((1 - yesPrice).toFixed(4)),
        yesPool:  Number(p.market.yesPool),
        noPool:   Number(p.market.noPool),
      },
    };
  });

  // ── Voided positions ───────────────────────────────────────────────────────
  // Positions on CANCELLED markets — shown in My Forecasts with VOIDED badge.
  // Shares have been zeroed by the void route, so we don't filter by shares > 0.
  const voidedRaw = await prisma.position.findMany({
    where: {
      userId: user.id,
      market: { status: 'CANCELLED' },
    },
    include: {
      market: {
        select: {
          id:        true,
          title:     true,
          status:    true,
          category:  true,
          updatedAt: true,  // proxy for void timestamp
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
    take:    20,  // cap at 20 — rare event, not worth paginating
  });

  // Deduplicate market IDs using filter — avoids Set spread (ES target compat)
  const voidedMarketIds = voidedRaw
    .map(p => p.market.id)
    .filter((id, index, arr) => arr.indexOf(id) === index);

  // Fetch gross stakes from Orders so we can show "Refunded KES X" in the badge
  const voidedOrders = voidedMarketIds.length > 0
    ? await prisma.order.groupBy({
        by:    ['marketId'],
        where: { userId: user.id, marketId: { in: voidedMarketIds } },
        _sum:  { amountKes: true },
      })
    : [];

  // Build lookup using plain object — avoids Map constructor tuple-type inference
  const stakeByMarket: Record<string, number> = {};
  for (const o of voidedOrders) {
    stakeByMarket[o.marketId] = Math.round(Number(o._sum.amountKes ?? 0));
  }

  const voidedPositions = voidedRaw.map(p => ({
    id:          p.id,
    side:        p.side,
    voidedAt:    p.market.updatedAt,
    refundedKes: stakeByMarket[p.market.id] ?? 0,
    market: {
      id:       p.market.id,
      title:    p.market.title,
      category: p.market.category,
      status:   p.market.status,
    },
  }));

  return NextResponse.json({ positions: enriched, voidedPositions });
});
