// src/app/api/admin/analytics/route.ts
// GET /api/admin/analytics — aggregated platform analytics for B2B panel

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const [markets, totalUsers, dataApps, txnStats] = await Promise.all([
    // All markets with volume and position data
    prisma.market.findMany({
      where:   { status: { in: ['OPEN', 'CLOSED', 'RESOLVED'] } },
      include: { _count: { select: { orders: true, positions: true } } },
    }),

    // Total active users
    prisma.user.count({ where: { suspended: false } }),

    // Data API applications (approved = active subscribers)
    prisma.dataApplication.groupBy({
      by:    ['status'],
      _count: { id: true },
    }),

    // Total trade volume
    prisma.transaction.aggregate({
      where: { type: { in: ['TRADE_BUY', 'TRADE_SELL'] }, status: 'SUCCESS' },
      _sum:  { amountKes: true },
    }),
  ]);

  // ── Category analytics ────────────────────────────────────────────────────
  const catMap: Record<string, {
    markets: number; trades: number; volume: number;
    yesSum: number; stakeSum: number; forecasters: number;
  }> = {};

  for (const m of markets) {
    const cat = m.category || 'GENERAL';
    if (!catMap[cat]) catMap[cat] = { markets: 0, trades: 0, volume: 0, yesSum: 0, stakeSum: 0, forecasters: 0 };

    const yesPool = Number(m.yesPool);
    const noPool  = Number(m.noPool);
    const total   = yesPool + noPool;
    const yesPct  = total > 0 ? Math.round((yesPool / total) * 100) : 50;
    const volume  = Number(m.totalVolume);
    const trades  = m._count.orders;

    catMap[cat].markets     += 1;
    catMap[cat].trades      += trades;
    catMap[cat].volume      += volume;
    catMap[cat].yesSum      += yesPct;
    catMap[cat].forecasters += m._count.positions;
    catMap[cat].stakeSum    += trades > 0 ? volume / trades : 0;
  }

  const categories = Object.entries(catMap).map(([cat, d]) => ({
    category:   cat,
    markets:    d.markets,
    trades:     d.trades,
    volumeKes:  Math.round(d.volume),
    yesPct:     d.markets > 0 ? Math.round(d.yesSum / d.markets) : 50,
    avgStake:   d.trades  > 0 ? Math.round(d.stakeSum / d.markets) : 0,
    forecasters: d.forecasters,
    conviction: d.trades > 500 ? 'High' : d.trades > 100 ? 'Medium' : 'Low',
  })).sort((a, b) => b.volumeKes - a.volumeKes);

  // ── Conviction scores per market (top 10 by volume) ───────────────────────
  const topMarkets = markets
    .sort((a, b) => Number(b.totalVolume) - Number(a.totalVolume))
    .slice(0, 10)
    .map(m => {
      const yesPool = Number(m.yesPool);
      const noPool  = Number(m.noPool);
      const total   = yesPool + noPool;
      const yesPct  = total > 0 ? Math.round((yesPool / total) * 100) : 50;
      const trades  = m._count.orders;
      const volume  = Number(m.totalVolume);
      const avgStake = trades > 0 ? Math.round(volume / trades) : 0;
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
  const totalVolume   = Number(txnStats._sum.amountKes ?? 0);
  const approvedApps  = dataApps.find(d => d.status === 'APPROVED')?._count.id ?? 0;
  const totalApps     = dataApps.reduce((s, d) => s + d._count.id, 0);
  const avgYesPct     = markets.length > 0
    ? Math.round(markets.reduce((s, m) => {
        const y = Number(m.yesPool), n = Number(m.noPool), t = y + n;
        return s + (t > 0 ? (y / t) * 100 : 50);
      }, 0) / markets.length)
    : 50;

  return NextResponse.json({
    summary: {
      totalVolume,
      totalUsers,
      totalMarkets:    markets.length,
      approvedDataApps: approvedApps,
      totalDataApps:   totalApps,
      avgSentiment:    avgYesPct,
    },
    categories,
    topMarkets,
  });
}
