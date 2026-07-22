// src/app/api/users/me/stats/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/security/route-guard';

export const GET = withErrorHandling(async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [orders, transactions] = await Promise.all([
    prisma.order.findMany({ where: { userId: user.id, status: 'FILLED' } }),
    prisma.transaction.findMany({ where: { userId: user.id, status: 'SUCCESS' } }),
  ]);

  // Wins / losses / winRate — driven from positions against CURRENTLY RESOLVED
  // markets. Unresolve-safe: rolling a market back to CLOSED removes it from
  // this count until it is re-resolved with the correct outcome.
  const resolvedPositions = await prisma.position.findMany({
    where:   { userId: user.id },
    include: { market: { select: { status: true, outcome: true } } },
  });
  const resolved  = resolvedPositions.filter(p => p.market.status === 'RESOLVED');
  const wins      = resolved.filter(p => p.market.outcome === p.side).length;
  const losses    = resolved.length - wins;
  const winRate   = resolved.length > 0 ? wins / resolved.length : 0;

  // Volume
  const tradeAmounts = orders.map(o => Number(o.amountKes));
  const totalVolume  = tradeAmounts.reduce((s, v) => s + v, 0);

  // P&L — PAYOUT credits minus TRADE_BUY spend, adjusted for REFUND clawbacks.
  // REFUND amountKes is negative (clawback), so adding it correctly reduces PnL.
  const payouts      = transactions.filter(t => t.type === 'PAYOUT');
  const refunds      = transactions.filter(t => t.type === 'REFUND');
  const totalPayouts = payouts.reduce((s, t) => s + Number(t.amountKes), 0);
  const totalRefunds = refunds.reduce((s, t) => s + Number(t.amountKes), 0);
  const totalSpent   = tradeAmounts.reduce((s, v) => s + v, 0);
  const totalRealizedPnl = totalPayouts + totalRefunds - totalSpent;

  // Best / worst trade
  const payoutAmounts = payouts.map(t => Number(t.amountKes));
  const bestTrade     = payoutAmounts.length > 0 ? Math.max(...payoutAmounts) : 0;
  const worstTrade    = tradeAmounts.length   > 0 ? -Math.min(...tradeAmounts) : 0;

  return NextResponse.json({
    totalPnl:    parseFloat(totalRealizedPnl.toFixed(2)),
    openValue:   0,
    winRate:     parseFloat(winRate.toFixed(4)),
    totalWins:   wins,
    totalLosses: losses,
    totalTrades: resolved.length,
    bestTrade,
    worstTrade,
    avgHoldDays: 14,
    totalVolume: parseFloat(totalVolume.toFixed(2)),
  });
});
