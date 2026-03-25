// src/app/api/leaderboard/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  const { searchParams } = new URL(req.url);
  const period = searchParams.get('period') ?? '30d';

  const days  = period === '7d' ? 7 : period === '30d' ? 30 : 3650;
  const since = new Date(Date.now() - days * 86400000);

  // Aggregate payouts per user in the period
  const payoutRows = await prisma.transaction.groupBy({
    by: ['userId'],
    where: { type: 'PAYOUT', status: 'SUCCESS', createdAt: { gte: since } },
    _sum: { amountKes: true },
    _count: { id: true },
    orderBy: { _sum: { amountKes: 'desc' } },
    take: 50,
  });

  // Trade counts and volumes
  const tradeRows = await prisma.order.groupBy({
    by: ['userId'],
    where: { status: 'FILLED', createdAt: { gte: since } },
    _sum: { amountKes: true },
    _count: { id: true },
  });
  const tradeMap = new Map(tradeRows.map(r => [r.userId, r]));

  // Fetch user details
  const userIds = payoutRows.map(r => r.userId);
  const users   = await prisma.user.findMany({ where: { id: { in: userIds } } });
  const userMap = new Map(users.map(u => [u.id, u]));

  // Build leaderboard
  const entries = payoutRows.map((row, i) => {
    const u      = userMap.get(row.userId) as any;
    const trades = tradeMap.get(row.userId);
    const profit = Number((row as any)._sum.amountKes ?? 0);
    const volume = Number((trades as any)?._sum?.amountKes ?? 0);
    const tradeCount = (trades as any)?._count?.id ?? 0;
    const winRate = tradeCount > 0 ? ((row as any)._count.id / tradeCount) : 0;

    return {
      rank:    i + 1,
      userId:  row.userId,
      name:    (u as any)?.name ?? `Trader #${row.userId.slice(0, 4)}`,
      profit:  parseFloat(profit.toFixed(2)),
      trades:  tradeCount,
      winRate: parseFloat(winRate.toFixed(4)),
      volume:  parseFloat(volume.toFixed(2)),
      isMe:    user?.id === row.userId,
    };
  });

  // Find current user's rank and how far they are from the next rank
  const myEntry  = user ? entries.find(e => e.userId === user.id) : null;
  const myRank   = myEntry?.rank ?? null;
  const prevEntry = myRank && myRank > 1 ? entries[myRank - 2] : null;
  const nextRank = prevEntry
    ? { rank: prevEntry.rank, profitNeeded: parseFloat((prevEntry.profit - (myEntry?.profit ?? 0)).toFixed(2)) }
    : null;

  return NextResponse.json({ entries, myRank, nextRank });
}
