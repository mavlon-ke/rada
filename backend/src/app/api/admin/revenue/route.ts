// src/app/api/admin/revenue/route.ts
// GET /api/admin/revenue — platform revenue dashboard
// Returns: totals by type, monthly breakdown, top markets, recent records

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  // ── Totals by type ────────────────────────────────────────────────────────
  const [feeAgg, surplusAgg, challengeAgg] = await Promise.all([
    prisma.platformRevenue.aggregate({
      where: { type: 'FORECASTING_FEE' },
      _sum:  { amountKes: true },
      _count: true,
    }),
    prisma.platformRevenue.aggregate({
      where: { type: 'MARKET_SURPLUS' },
      _sum:  { amountKes: true },
      _count: true,
    }),
    prisma.platformRevenue.aggregate({
      where: { type: 'CHALLENGE_FEE' },
      _sum:  { amountKes: true },
      _count: true,
    }),
  ]);

  const totalFees      = Number(feeAgg._sum.amountKes ?? 0);
  const totalSurplus   = Number(surplusAgg._sum.amountKes ?? 0);
  const totalChallenge = Number(challengeAgg._sum.amountKes ?? 0);
  const grandTotal     = totalFees + totalSurplus + totalChallenge;

  // ── Monthly breakdown (last 6 months) ────────────────────────────────────
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const monthlyRecords = await prisma.platformRevenue.findMany({
    where:   { createdAt: { gte: sixMonthsAgo } },
    select:  { type: true, amountKes: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  // Group by month
  const monthlyMap: Record<string, { fees: number; surplus: number; challenge: number; total: number }> = {};
  for (const r of monthlyRecords) {
    const month = r.createdAt.toISOString().slice(0, 7); // YYYY-MM
    if (!monthlyMap[month]) monthlyMap[month] = { fees: 0, surplus: 0, challenge: 0, total: 0 };
    const amt = Number(r.amountKes);
    if (r.type === 'FORECASTING_FEE') monthlyMap[month].fees      += amt;
    if (r.type === 'MARKET_SURPLUS')  monthlyMap[month].surplus   += amt;
    if (r.type === 'CHALLENGE_FEE')   monthlyMap[month].challenge += amt;
    monthlyMap[month].total += amt;
  }
  const monthly = Object.entries(monthlyMap).map(([month, data]) => ({ month, ...data }));

  // ── Top 5 markets by revenue ──────────────────────────────────────────────
  const topMarketsRaw = await prisma.platformRevenue.groupBy({
    by:      ['marketId'],
    where:   { marketId: { not: null } },
    _sum:    { amountKes: true },
    orderBy: { _sum: { amountKes: 'desc' } },
    take:    5,
  });

  const topMarkets = await Promise.all(
    topMarketsRaw.map(async (r) => {
      const market = r.marketId ? await prisma.market.findUnique({
        where:  { id: r.marketId },
        select: { title: true, status: true },
      }) : null;
      return {
        marketId:  r.marketId,
        title:     market?.title?.slice(0, 60) ?? 'Unknown',
        status:    market?.status ?? '—',
        totalKes:  Number(r._sum.amountKes ?? 0),
      };
    })
  );

  // ── Recent revenue records (last 20) ─────────────────────────────────────
  const recent = await prisma.platformRevenue.findMany({
    orderBy: { createdAt: 'desc' },
    take:    20,
    include: {
      market:    { select: { title: true } },
      challenge: { select: { question: true } },
    },
  });

  const recentFormatted = recent.map(r => ({
    id:          r.id,
    type:        r.type,
    amountKes:   Number(r.amountKes),
    description: r.description,
    marketTitle: r.market?.title?.slice(0, 50) ?? null,
    challengeQ:  r.challenge?.question?.slice(0, 50) ?? null,
    createdAt:   r.createdAt,
  }));

  return NextResponse.json({
    totals: {
      forecastingFees: totalFees,
      marketSurplus:   totalSurplus,
      challengeFees:   totalChallenge,
      grandTotal,
    },
    counts: {
      forecastingFees: feeAgg._count,
      marketSurplus:   surplusAgg._count,
      challengeFees:   challengeAgg._count,
    },
    monthly,
    topMarkets,
    recent: recentFormatted,
  });
}
