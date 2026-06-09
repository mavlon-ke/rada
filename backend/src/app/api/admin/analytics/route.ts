// src/app/api/admin/analytics/route.ts
// GET /api/admin/analytics — aggregated platform analytics for B2B panel
//
// Fixes applied:
//  1. Added force-dynamic (prevents stale cached response)
//  2. Added try/catch (proper 500 on DB errors)
//  3. Volume now uses SUM(market.totalVolume) — the real net KES in the system
//  4. avgStake fixed: totalVolume/totalTrades (not avg-of-averages)
//  5. yesPct fixed: uses actual order amounts by side (not LMSR pool values
//     which are skewed by DEFAULT_B=1000)

import { NextRequest, NextResponse } from 'next/server';
import { prisma }                    from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  try {
    const [markets, totalUsers, dataApps] = await Promise.all([
      // All non-cancelled markets with trade counts
      prisma.market.findMany({
        where:   { status: { in: ['OPEN', 'CLOSED', 'RESOLVED'] } },
        select: {
          id: true, title: true, category: true, status: true,
          totalVolume: true, yesPool: true, noPool: true,
          _count: { select: { orders: true, positions: true } },
        },
      }),

      // Active (non-suspended) users
      prisma.user.count({ where: { suspended: false } }),

      // Data API application statuses
      prisma.dataApplication.groupBy({
        by:    ['status'],
        _count: { id: true },
      }),
    ]);

    const marketIds = markets.map(m => m.id);

    // ── Accurate YES/NO sentiment from actual order amounts ───────────────────
    // Using order amounts (not LMSR pool values) avoids the DEFAULT_B=1000 bias.
    // Pool-based sentiment: 100% YES market shows as ~52% due to liquidity param.
    // Order-based sentiment: 100% YES market correctly shows as 100%.
    const orderSides = await prisma.order.groupBy({
      by:    ['marketId', 'side'],
      where: { status: 'FILLED', marketId: { in: marketIds } },
      _sum:  { amountKes: true },
    });

    // Build per-market YES/NO stake map
    const sideMap = new Map<string, { yes: number; no: number }>();
    for (const r of orderSides) {
      if (!sideMap.has(r.marketId)) sideMap.set(r.marketId, { yes: 0, no: 0 });
      const entry = sideMap.get(r.marketId)!;
      if (r.side === 'YES') entry.yes = Number(r._sum.amountKes ?? 0);
      else                  entry.no  = Number(r._sum.amountKes ?? 0);
    }

    // ── Category analytics ────────────────────────────────────────────────────
    type CatEntry = {
      markets: number; trades: number; totalVolume: number;
      yesStaked: number; noStaked: number; forecasters: number;
    };
    const catMap: Record<string, CatEntry> = {};

    for (const m of markets) {
      const cat    = m.category || 'GENERAL';
      const volume = Number(m.totalVolume);
      const trades = m._count.orders;
      const sides  = sideMap.get(m.id) ?? { yes: 0, no: 0 };

      if (!catMap[cat]) catMap[cat] = {
        markets: 0, trades: 0, totalVolume: 0,
        yesStaked: 0, noStaked: 0, forecasters: 0,
      };

      catMap[cat].markets     += 1;
      catMap[cat].trades      += trades;
      catMap[cat].totalVolume += volume;
      catMap[cat].yesStaked   += sides.yes;
      catMap[cat].noStaked    += sides.no;
      catMap[cat].forecasters += m._count.positions;
    }

    const categories = Object.entries(catMap).map(([cat, d]) => {
      const totalStaked = d.yesStaked + d.noStaked;
      const yesPct = totalStaked > 0 ? Math.round((d.yesStaked / totalStaked) * 100) : 50;
      // Fix: avgStake = totalVolume / totalTrades (not avg-of-averages)
      const avgStake = d.trades > 0 ? Math.round(d.totalVolume / d.trades) : 0;
      return {
        category:    cat,
        markets:     d.markets,
        trades:      d.trades,
        volumeKes:   Math.round(d.totalVolume),
        yesPct,
        avgStake,
        forecasters: d.forecasters,
        conviction:  d.trades > 500 ? 'High' : d.trades > 100 ? 'Medium' : 'Low',
      };
    }).sort((a, b) => b.volumeKes - a.volumeKes);

    // ── Top 10 markets by volume with accurate sentiment ──────────────────────
    const topMarkets = [...markets]
      .sort((a, b) => Number(b.totalVolume) - Number(a.totalVolume))
      .slice(0, 10)
      .map(m => {
        const sides      = sideMap.get(m.id) ?? { yes: 0, no: 0 };
        const total      = sides.yes + sides.no;
        const yesPct     = total > 0 ? Math.round((sides.yes / total) * 100) : 50;
        const volume     = Number(m.totalVolume);
        const trades     = m._count.orders;
        const avgStake   = trades > 0 ? Math.round(volume / trades) : 0;
        return {
          title:       m.title,
          category:    m.category,
          yesPct,
          avgStake,
          forecasters: m._count.positions,
          conviction:  avgStake > 1000 ? 'High' : avgStake > 400 ? 'Medium' : 'Low',
        };
      });

    // ── Summary stats ─────────────────────────────────────────────────────────
    // Total volume = sum of all market.totalVolume (real net KES in system)
    const totalVolume  = markets.reduce((s, m) => s + Number(m.totalVolume), 0);
    const approvedApps = dataApps.find(d => d.status === 'APPROVED')?._count.id ?? 0;
    const totalApps    = dataApps.reduce((s, d) => s + d._count.id, 0);

    // Avg platform-wide sentiment (order-based)
    let allYes = 0, allNo = 0;
    for (const m of markets) {
      const s = sideMap.get(m.id) ?? { yes: 0, no: 0 };
      allYes += s.yes; allNo += s.no;
    }
    const avgSentiment = (allYes + allNo) > 0
      ? Math.round((allYes / (allYes + allNo)) * 100)
      : 50;

    return NextResponse.json({
      summary: {
        totalVolume: Math.round(totalVolume),
        totalUsers,
        totalMarkets:     markets.length,
        approvedDataApps: approvedApps,
        totalDataApps:    totalApps,
        avgSentiment,
      },
      categories,
      topMarkets,
    });

  } catch (err: any) {
    console.error('[admin/analytics] GET error:', err?.message ?? err);
    return NextResponse.json(
      { error: 'Failed to load analytics', detail: err?.message },
      { status: 500 }
    );
  }
}
