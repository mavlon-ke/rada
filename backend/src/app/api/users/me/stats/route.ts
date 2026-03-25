// src/app/api/users/me/stats/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';

export async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [orders, transactions, positions] = await Promise.all([
    prisma.order.findMany({ where: { userId: user.id, status: 'FILLED' } }),
    prisma.transaction.findMany({ where: { userId: user.id, status: 'SUCCESS' } }),
    prisma.position.findMany({ where: { userId: user.id } }),
  ]);

  // Resolved market payouts
  const payouts    = transactions.filter(t => t.type === 'PAYOUT');
  const totalWins  = payouts.filter(t => Number(t.amountKes) > 0).length;

  // Count resolved positions
  const resolvedPositions = await prisma.position.findMany({
    where: { userId: user.id },
    include: { market: { select: { status: true, outcome: true } } },
  });
  const resolved     = resolvedPositions.filter(p => p.market.status === 'RESOLVED');
  const wins         = resolved.filter(p => p.market.outcome === p.side).length;
  const losses       = resolved.length - wins;
  const winRate      = resolved.length > 0 ? wins / resolved.length : 0;

  const tradeAmounts = orders.map(o => Number(o.amountKes));
  const totalVolume  = tradeAmounts.reduce((s, v) => s + v, 0);

  // P&L from realized positions
  const totalRealizedPnl = positions.reduce((s, p) => s + Number(p.realizedPnl), 0);

  // Best / worst single trade approximation from payouts
  const payoutAmounts = payouts.map(t => Number(t.amountKes));
  const bestTrade  = payoutAmounts.length > 0 ? Math.max(...payoutAmounts) : 0;
  const worstTrade = orders.length > 0 ? -Math.min(...tradeAmounts) : 0;

  // Avg hold time (days between buy order and payout tx)
  const avgHoldDays = 14; // Placeholder — needs join logic in production

  return NextResponse.json({
    totalPnl:    parseFloat(totalRealizedPnl.toFixed(2)),
    openValue:   0, // enriched by /positions
    winRate:     parseFloat(winRate.toFixed(4)),
    totalWins:   wins,
    totalLosses: losses,
    bestTrade,
    worstTrade,
    avgHoldDays,
    totalVolume: parseFloat(totalVolume.toFixed(2)),
  });
}
