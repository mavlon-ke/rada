// src/app/api/users/me/positions/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { getYesPrice } from '@/lib/market/amm';

export async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const positions = await prisma.position.findMany({
    where: { userId: user.id, shares: { gt: 0 } },
    include: { market: true },
    orderBy: { updatedAt: 'desc' },
  });

  const enriched = positions.map(p => {
    const yesPrice  = getYesPrice(Number(p.market.yesPool), Number(p.market.noPool));
    const currentProb = p.side === 'YES' ? yesPrice : 1 - yesPrice;
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
        yesPrice:  parseFloat(yesPrice.toFixed(4)),
        noPrice:   parseFloat((1 - yesPrice).toFixed(4)),
        yesPool:   Number(p.market.yesPool),
        noPool:    Number(p.market.noPool),
      },
    };
  });

  return NextResponse.json({ positions: enriched });
}
