// src/app/api/admin/revenue/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';

function dateWhere(from?: string | null, to?: string | null) {
  if (!from && !to) return undefined;
  const gte = from ? new Date(from)                          : undefined;
  const lte = to   ? new Date(to + 'T23:59:59.999Z')        : undefined;
  return { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
}

// B2C Registered User tariff — Safaricom Business cost per withdrawal (Business Bouquet plan)
// Customer pays KES 0 on all bands; business (CheckRada) pays these amounts:
function b2cFee(amountKes: number): number {
  const amt = Math.abs(amountKes);
  if (amt <=   100) return  0;
  if (amt <= 1_500) return  4;
  if (amt <= 5_000) return  8;
  if (amt <= 20_000) return 10;
  return 12; // KES 20,001–150,000
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  try {
    const sp = new URL(req.url).searchParams;
    const volumeFrom = sp.get('volumeFrom');
    const volumeTo   = sp.get('volumeTo');
    const periodFrom = sp.get('periodFrom');
    const periodTo   = sp.get('periodTo');
    const monthFrom  = sp.get('monthFrom');
    const monthTo    = sp.get('monthTo');

    // ── 1. GROSS REVENUE — all time ─────────────────────────────────────────
    const [feeAgg, surplusAgg, challengeAgg] = await Promise.all([
      prisma.platformRevenue.aggregate({
        where: { type: 'FORECASTING_FEE' },
        _sum: { amountKes: true }, _count: { id: true },
      }),
      prisma.platformRevenue.aggregate({
        where: { type: 'MARKET_SURPLUS' },
        _sum: { amountKes: true }, _count: { id: true },
      }),
      prisma.platformRevenue.aggregate({
        where: { type: 'CHALLENGE_FEE' },
        _sum: { amountKes: true }, _count: { id: true },
      }),
    ]);

    const totalFees      = Number(feeAgg._sum.amountKes      ?? 0);
    const totalSurplus   = Number(surplusAgg._sum.amountKes  ?? 0);
    const totalChallenge = Number(challengeAgg._sum.amountKes ?? 0);
    const grossTotal     = totalFees + totalSurplus + totalChallenge;

    // ── 2. COSTS — all time ──────────────────────────────────────────────────
    const [suggAgg, referralAgg, bountyAgg, royaltyAgg] = await Promise.all([
      prisma.transaction.aggregate({
        where: { type: 'SUGGESTION_REWARD', status: 'SUCCESS' },
        _sum: { amountKes: true },
      }),
      prisma.transaction.aggregate({
        where: { type: 'REFERRAL_REWARD', status: 'SUCCESS' },
        _sum: { amountKes: true },
      }),
      prisma.transaction.aggregate({
        where: { type: 'CREATOR_BOUNTY', status: 'SUCCESS' },
        _sum: { amountKes: true },
      }),
      prisma.platformRevenue.aggregate({
        where: { type: 'CREATOR_ROYALTY_PAID' },
        _sum: { amountKes: true },
      }),
    ]);

    const costSuggestion = Number(suggAgg._sum.amountKes     ?? 0);
    const costReferral   = Number(referralAgg._sum.amountKes ?? 0);
    const costBounty     = Number(bountyAgg._sum.amountKes   ?? 0);
    const costRoyalty    = Math.abs(Number(royaltyAgg._sum.amountKes ?? 0));

    // B2C transfer fees — Safaricom charges CheckRada per disbursement withdrawal
    // Fetches individual withdrawal amounts to apply the banded tariff table
    const wdAmounts = await prisma.transaction.findMany({
      where:  { type: 'WITHDRAWAL', status: 'SUCCESS', amountKes: { lt: 0 } },
      select: { amountKes: true },
    });
    const costB2cFees = wdAmounts.reduce(
      (sum, t) => sum + b2cFee(Number(t.amountKes)), 0
    );
    const b2cFeeCount = wdAmounts.length;

    const totalCosts = costSuggestion + costReferral + costBounty + costRoyalty + costB2cFees;
    const netRevenue = grossTotal - totalCosts;

    // ── 3. PLATFORM CONFIG — current rates ───────────────────────────────────
    const config = await prisma.platformConfig.findUnique({ where: { id: 'singleton' } });
    const feeRate = config ? Number(config.forecastingFeeRate) : 0.05;
    const cutRate = config ? Number(config.resolutionCutRate)  : 0.20;

    // ── 4. TRADE VOLUME — filterable ─────────────────────────────────────────
    const volDW = dateWhere(volumeFrom, volumeTo);
    const tradeAgg = await prisma.transaction.aggregate({
      where: {
        type:   'TRADE_BUY',
        status: 'SUCCESS',
        ...(volDW ? { createdAt: volDW } : {}),
      },
      _sum:   { amountKes: true },
      _count: { id: true },
    });
    // TRADE_BUY amountKes is a negative wallet debit — take absolute value for display
    const tradeTotal = Math.abs(Number(tradeAgg._sum.amountKes ?? 0));
    const tradeCount = tradeAgg._count.id;
    const tradeAvg   = tradeCount > 0 ? Math.round(tradeTotal / tradeCount) : 0;

    // ── 5. LIQUIDITY — all time ──────────────────────────────────────────────
    // Real M-Pesa only. Admin manual adjustments are stored as DEPOSIT/WITHDRAWAL
    // type but are internal wallet corrections — NOT real M-Pesa money flows.
    // Deposits: description startsWith 'M-Pesa deposit' (STK Push confirmed)
    // Withdrawals: amountKes < 0 (admin debit adjustments have positive amountKes)
    const [depAgg, wdAgg, adminCredAgg, adminDebAgg] = await Promise.all([
      prisma.transaction.aggregate({
        where: { type: 'DEPOSIT', status: 'SUCCESS', description: { startsWith: 'M-Pesa deposit' } },
        _sum: { amountKes: true }, _count: { id: true },
      }),
      prisma.transaction.aggregate({
        where: { type: 'WITHDRAWAL', status: 'SUCCESS', amountKes: { lt: 0 } },
        _sum: { amountKes: true }, _count: { id: true },
      }),
      // Admin credits (transparency — not M-Pesa backed)
      prisma.transaction.aggregate({
        where: { type: 'DEPOSIT', status: 'SUCCESS', description: { startsWith: 'Admin' } },
        _sum: { amountKes: true }, _count: { id: true },
      }),
      // Admin debits (transparency — not real M-Pesa outflows)
      prisma.transaction.aggregate({
        where: { type: 'WITHDRAWAL', status: 'SUCCESS', amountKes: { gt: 0 } },
        _sum: { amountKes: true }, _count: { id: true },
      }),
    ]);

    const totalDeposits    = Number(depAgg._sum.amountKes     ?? 0);
    const totalWithdrawals = Math.abs(Number(wdAgg._sum.amountKes ?? 0));
    const netCash          = totalDeposits - totalWithdrawals;
    const adminCredits     = Number(adminCredAgg._sum.amountKes ?? 0);
    const adminDebits      = Number(adminDebAgg._sum.amountKes  ?? 0);
    const netAdminAdjust   = adminCredits - adminDebits;
    const totalPaystackFees = 0; // Daraja B2C has no per-transaction fee

    // ── 6. LIQUIDITY — current snapshot ─────────────────────────────────────
    const [walletAgg, bonusAgg, pendingDepAgg, pendingWdAgg] = await Promise.all([
      prisma.user.aggregate({ _sum: { balanceKes:      true } }),
      prisma.user.aggregate({ _sum: { bonusBalanceKes: true } }),
      // Pending deposits: last 2 hours only — STK Push expires within minutes.
      // Older PENDING records are stale (cancelled / timed-out) and not real obligations.
      prisma.transaction.aggregate({
        where: {
          type:      'DEPOSIT',
          status:    'PENDING',
          createdAt: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
        },
        _sum: { amountKes: true }, _count: { id: true },
      }),
      // Pending withdrawals: last 10 minutes only — Daraja B2C completes within minutes.
      prisma.transaction.aggregate({
        where: {
          type:      'WITHDRAWAL',
          status:    'PENDING',
          createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) },
        },
        _sum: { amountKes: true }, _count: { id: true },
      }),
    ]);

    const walletLiability   = Number(walletAgg._sum.balanceKes     ?? 0);
    const bonusBalances      = Number(bonusAgg._sum.bonusBalanceKes ?? 0);
    const pendingDeposits    = Number(pendingDepAgg._sum.amountKes  ?? 0);
    const pendingWithdrawals = Math.abs(Number(pendingWdAgg._sum.amountKes ?? 0));

    // Full platform liability = wallets + active market pools + active challenge pools
    const [marketPoolAgg, challengePoolAgg] = await Promise.all([
      prisma.market.aggregate({
        where: { status: { in: ['OPEN', 'CLOSED'] } },
        _sum:  { totalVolume: true },
      }),
      prisma.marketChallenge.aggregate({
        where: { status: { notIn: ['RESOLVED', 'CANCELLED'] } },
        _sum:  { totalPool: true },
      }),
    ]);
    const marketPools    = Number(marketPoolAgg._sum.totalVolume  ?? 0);
    const challengePools = Number(challengePoolAgg._sum.totalPool ?? 0);
    const totalLiability = walletLiability + marketPools + challengePools;

    // liquidityGap: positive = solvent surplus, negative = platform is underfunded
    const liquidityGap = netCash - totalLiability;

    // ── 7. DEPOSITS & WITHDRAWALS — period filter ────────────────────────────
    const periodDW = dateWhere(periodFrom, periodTo);
    const [pDepAgg, pWdAgg] = await Promise.all([
      // Real M-Pesa deposits only in period
      prisma.transaction.aggregate({
        where: {
          type:        'DEPOSIT',
          status:      'SUCCESS',
          description: { startsWith: 'M-Pesa deposit' },
          ...(periodDW ? { createdAt: periodDW } : {}),
        },
        _sum: { amountKes: true }, _count: { id: true },
      }),
      // Real M-Pesa withdrawal debits only in period
      prisma.transaction.aggregate({
        where: {
          type:      'WITHDRAWAL',
          status:    'SUCCESS',
          amountKes: { lt: 0 },
          ...(periodDW ? { createdAt: periodDW } : {}),
        },
        _sum: { amountKes: true }, _count: { id: true },
      }),
    ]);

    const periodDepTotal     = Number(pDepAgg._sum.amountKes ?? 0);
    const periodWdTotal      = Math.abs(Number(pWdAgg._sum.amountKes ?? 0));
    const periodPaystackFees = 0; // Daraja B2C: no per-transaction fee

    // ── 8. MONTHLY BREAKDOWN — adaptive grouping ─────────────────────────────
    const monthSince = monthFrom ? new Date(monthFrom) : new Date(Date.now() - 180 * 86400000);
    const monthUntil = monthTo   ? new Date(monthTo + 'T23:59:59.999Z') : new Date();
    const diffDays   = (monthUntil.getTime() - monthSince.getTime()) / 86400000;
    const groupBy    = diffDays <= 14 ? 'day' : diffDays <= 90 ? 'week' : 'month';

    const monthlyRaw = await prisma.platformRevenue.findMany({
      where: {
        type:      { in: ['FORECASTING_FEE', 'MARKET_SURPLUS', 'CHALLENGE_FEE'] },
        createdAt: { gte: monthSince, lte: monthUntil },
      },
      select:  { type: true, amountKes: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const periodMap: Record<string, { fees: number; surplus: number; challenge: number }> = {};
    for (const r of monthlyRaw) {
      const d = new Date(r.createdAt);
      let key: string;
      if (groupBy === 'day') {
        key = d.toISOString().slice(0, 10);
      } else if (groupBy === 'week') {
        const day = d.getDay() || 7;
        const mon = new Date(d);
        mon.setDate(d.getDate() - day + 1);
        key = 'Wk ' + mon.toISOString().slice(0, 10);
      } else {
        key = d.toISOString().slice(0, 7);
      }
      if (!periodMap[key]) periodMap[key] = { fees: 0, surplus: 0, challenge: 0 };
      const amt = Number(r.amountKes);
      if (r.type === 'FORECASTING_FEE') periodMap[key].fees      += amt;
      if (r.type === 'MARKET_SURPLUS')  periodMap[key].surplus   += amt;
      if (r.type === 'CHALLENGE_FEE')   periodMap[key].challenge += amt;
    }
    const monthly = Object.entries(periodMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, v]) => ({ period, ...v, total: v.fees + v.surplus + v.challenge }));

    // ── 9. TOP MARKETS — N+1 fixed (single findMany) ─────────────────────────
    const topRaw = await prisma.platformRevenue.groupBy({
      by:      ['marketId'],
      where:   { type: { in: ['FORECASTING_FEE', 'MARKET_SURPLUS'] }, marketId: { not: null } },
      _sum:    { amountKes: true },
      orderBy: { _sum: { amountKes: 'desc' } },
      take:    5,
    });

    const mIds    = topRaw.map(r => r.marketId!);
    const mDetails = await prisma.market.findMany({
      where:  { id: { in: mIds } },
      select: { id: true, title: true, status: true },
    });
    const mMap    = new Map(mDetails.map(m => [m.id, m]));
    const topMarkets = topRaw.map(r => ({
      title:   mMap.get(r.marketId!)?.title?.slice(0, 60) ?? 'Unknown',
      status:  mMap.get(r.marketId!)?.status ?? '—',
      revenue: Number(r._sum.amountKes ?? 0),
    }));

    // ── 10. RECENT RECORDS ───────────────────────────────────────────────────
    const recent = await prisma.platformRevenue.findMany({
      where:   { type: { in: ['FORECASTING_FEE', 'MARKET_SURPLUS', 'CHALLENGE_FEE'] } },
      orderBy: { createdAt: 'desc' },
      take:    20,
      include: { market: { select: { title: true } } },
    });

    return NextResponse.json({
      // Gross
      totalFees, feesCount: feeAgg._count.id,
      totalSurplus, surplusCount: surplusAgg._count.id,
      totalChallenge, challengeCount: challengeAgg._count.id,
      grossTotal,
      // Costs
      costSuggestion, costReferral, costBounty, costRoyalty,
      costB2cFees, b2cFeeCount,
      totalCosts,
      // Net
      netRevenue,
      // Config
      feeRate, cutRate,
      // Trade volume
      tradeTotal, tradeCount, tradeAvg,
      // Liquidity all-time (real M-Pesa only — admin adjustments excluded)
      totalDeposits,    depCount:      depAgg._count.id,
      totalWithdrawals, wdCount:       wdAgg._count.id,
      netCash, totalPaystackFees,
      // Admin manual wallet adjustments (tracked separately for transparency)
      adminCredits,  adminCredCount: adminCredAgg._count.id,
      adminDebits,   adminDebCount:  adminDebAgg._count.id,
      netAdminAdjust,
      // Full platform liability and snapshot
      walletLiability, bonusBalances,
      marketPools, challengePools, totalLiability,
      pendingDeposits,    pendingDepCount: pendingDepAgg._count.id,
      pendingWithdrawals, pendingWdCount:  pendingWdAgg._count.id,
      liquidityGap,
      // Period cash flow (real M-Pesa only)
      periodDepTotal, periodDepCount: pDepAgg._count.id,
      periodWdTotal,  periodWdCount:  pWdAgg._count.id,
      periodNetFlow:  periodDepTotal - periodWdTotal,
      periodPaystackFees,
      // Monthly
      monthly, groupBy,
      // Top markets
      topMarkets,
      // Recent
      recent: recent.map(r => ({
        createdAt:   r.createdAt,
        type:        r.type,
        marketTitle: r.market?.title?.slice(0, 50) ?? null,
        amountKes:   Number(r.amountKes),
      })),
    });

  } catch (err: any) {
    console.error('[admin/revenue] GET error:', err?.message ?? err);
    return NextResponse.json(
      { error: 'Failed to load revenue data', detail: err?.message },
      { status: 500 }
    );
  }
}
