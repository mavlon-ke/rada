// src/app/api/leaderboard/route.ts
//
// Ranking metric: net profit = total payouts received − total staked (gross)
// Win rate: markets won ÷ total resolved markets participated in
//
// Previous bugs fixed:
//   1. profit was SUM(PAYOUT txns) — gross payout, not net earnings. Caused 5–10×
//      exaggeration because staked amounts were never subtracted.
//   2. winRate mixed units: PAYOUT count (per market) ÷ Order count (per trade).
//      Now computed from resolved Position records: wins ÷ total resolved.

import { NextRequest, NextResponse } from 'next/server';
import { prisma }                    from '@/lib/db/prisma';
import { requireAuth }               from '@/lib/auth/session';

export async function GET(req: NextRequest) {
  const user   = await requireAuth(req);
  const { searchParams } = new URL(req.url);
  const period = searchParams.get('period') ?? '30d';

  const days  = period === '7d' ? 7 : period === '30d' ? 30 : 3650;
  const since = new Date(Date.now() - days * 86400000);

  // ── 1. Payouts per user in the period ─────────────────────────────────────
  // Fetch 100 (wider net) so re-sorting by net profit doesn't miss anyone
  const payoutRows = await prisma.transaction.groupBy({
    by:      ['userId'],
    where:   { type: 'PAYOUT', status: 'SUCCESS', createdAt: { gte: since } },
    _sum:    { amountKes: true },
    _count:  { id: true },
    orderBy: { _sum: { amountKes: 'desc' } },
    take:    100,
  });

  const userIds = payoutRows.map(r => r.userId).filter(Boolean) as string[];
  if (!userIds.length) return NextResponse.json({ entries: [], myRank: null, nextRank: null });

  // ── 2. Total staked (gross) per user in the period ─────────────────────────
  const tradeRows = await prisma.order.groupBy({
    by:    ['userId'],
    where: { userId: { in: userIds }, status: 'FILLED', createdAt: { gte: since } },
    _sum:  { amountKes: true },
    _count: { id: true },
  });
  const tradeMap = new Map(tradeRows.map(r => [r.userId, r]));

  // ── 3. Win rate from resolved positions in the period ─────────────────────
  // Correct units: one position per market per user.
  // A position is a WIN if market.outcome === position.side.
  const resolvedPositions = await prisma.position.findMany({
    where: {
      userId: { in: userIds },
      shares: { gt: 0 },
      market: { status: 'RESOLVED', resolvedAt: { gte: since } },
    },
    select: {
      userId: true,
      side:   true,
      market: { select: { outcome: true } },
    },
  });

  const winMap = new Map<string, { wins: number; total: number }>();
  for (const pos of resolvedPositions) {
    const uid = pos.userId;
    if (!winMap.has(uid)) winMap.set(uid, { wins: 0, total: 0 });
    const entry = winMap.get(uid)!;
    entry.total++;
    if (pos.market.outcome === pos.side) entry.wins++;
  }

  // ── 4. User names ──────────────────────────────────────────────────────────
  const users   = await prisma.user.findMany({
    where:  { id: { in: userIds } },
    select: { id: true, name: true },
  });
  const userMap = new Map(users.map(u => [u.id, u]));

  // ── 5. Build and rank entries ──────────────────────────────────────────────
  const entries = payoutRows
    .map(row => {
      const u       = userMap.get(row.userId);
      const trades  = tradeMap.get(row.userId);
      const winData = winMap.get(row.userId);

      const totalPayouts  = Number(row._sum.amountKes   ?? 0);
      const totalStaked   = Number(trades?._sum?.amountKes ?? 0);
      const profit        = totalPayouts - totalStaked;    // ← true net profit
      const tradeCount    = trades?._count?.id            ?? 0;
      const wins          = winData?.wins                 ?? 0;
      const totalResolved = winData?.total                ?? 0;
      const winRate       = totalResolved > 0 ? wins / totalResolved : 0;

      return {
        userId:       row.userId,
        name:         u?.name ?? `Trader #${row.userId.slice(0, 4)}`,
        profit:       parseFloat(profit.toFixed(2)),
        volume:       parseFloat(totalStaked.toFixed(2)),
        trades:       tradeCount,
        winRate:      parseFloat(winRate.toFixed(4)),
        wins,
        totalResolved,
        isMe:         user?.id === row.userId,
      };
    })
    .sort((a, b) => b.profit - a.profit)   // re-sort by true net profit
    .slice(0, 50)
    .map((e, i) => ({ ...e, rank: i + 1 }));

  // ── 6. Current user position ───────────────────────────────────────────────
  const myEntry   = user ? entries.find(e => e.userId === user.id) : null;
  const myRank    = myEntry?.rank ?? null;
  const prevEntry = myRank && myRank > 1 ? entries[myRank - 2] : null;
  const nextRank  = prevEntry
    ? {
        rank:         prevEntry.rank,
        profitNeeded: parseFloat((prevEntry.profit - (myEntry?.profit ?? 0)).toFixed(2)),
      }
    : null;

  return NextResponse.json({ entries, myRank, nextRank });
}
