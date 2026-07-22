// src/app/api/users/me/portfolio-history/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/security/route-guard';

export const GET = withErrorHandling(async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const period = searchParams.get('period') ?? '30d';

  const days = period === '7d' ? 7 : period === '30d' ? 30 : 365;
  const since = new Date(Date.now() - days * 86400000);

  // Get all transactions since the start date
  const txns = await prisma.transaction.findMany({
    where: { userId: user.id, status: 'SUCCESS', createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
  });

  // Get the balance at the start of the period
  const startingBalanceTx = await prisma.transaction.findFirst({
    where: { userId: user.id, status: 'SUCCESS', createdAt: { lt: since } },
    orderBy: { createdAt: 'desc' },
  });
  const startingBalance = startingBalanceTx ? Number(startingBalanceTx.balAfter) : 0;

  // Get all deposits since account creation
  const allDeposits = await prisma.transaction.findMany({
    where: { userId: user.id, status: 'SUCCESS', type: { in: ['DEPOSIT', 'WITHDRAWAL'] } },
    orderBy: { createdAt: 'asc' },
  });
  const totalDeposited = allDeposits
    .filter(t => t.createdAt <= since)
    .reduce((s, t) => s + Number(t.amountKes), 0);

  // Build day-by-day series
  const history: { date: string; portfolioValue: number; deposited: number }[] = [];

  let runningBalance = startingBalance;
  let runningDeposited = totalDeposited;

  for (let d = 0; d < days; d++) {
    const date = new Date(since.getTime() + d * 86400000);
    const dateStr = date.toISOString().split('T')[0];
    const nextDate = new Date(date.getTime() + 86400000);

    // Apply txns for this day
    const dayTxns = txns.filter(t => t.createdAt >= date && t.createdAt < nextDate);
    for (const t of dayTxns) {
      runningBalance = Number(t.balAfter);
      if (t.type === 'DEPOSIT')    runningDeposited += Number(t.amountKes);
      if (t.type === 'WITHDRAWAL') runningDeposited += Number(t.amountKes); // negative
    }

    history.push({
      date: dateStr,
      portfolioValue: parseFloat(runningBalance.toFixed(2)),
      deposited: parseFloat(runningDeposited.toFixed(2)),
    });
  }

  // ── chartData: reshape history into the format the portfolio chart expects ──
  // Portfolio page reads: CHART_DATA[period].portfolio[] and .deposited[]
  const chartData = {
    portfolio: history.map(h => h.portfolioValue),
    deposited: history.map(h => h.deposited),
    labels:    history.map(h => h.date),
  };

  // ── transactions: return recent txns for the portfolio transaction list ────
  // Returned newest-first so the list renders in reverse-chronological order.
  // Serialise Decimal fields to numbers so the frontend doesn't get objects.
  const recentTxns = [...txns].reverse().map(t => ({
    id:          t.id,
    type:        t.type,
    amountKes:   Number(t.amountKes),
    balAfter:    Number(t.balAfter),
    status:      t.status,
    description: t.description,
    mpesaRef:    t.mpesaRef,
    createdAt:   t.createdAt,
  }));

  return NextResponse.json({ history, chartData, transactions: recentTxns });
});
