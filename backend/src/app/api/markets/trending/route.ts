// src/app/api/markets/trending/route.ts
// GET /api/markets/trending
// Returns top 5 markets ranked by trending score.
//
// Trending score = (tradesLast24h × 3) + (|yesShift24h| × 2) + (closingSoon ? 20 : 0) + (isNew ? 10 : 0)
//
// All fields computed from live orders data — no extra schema needed.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

function lmsrPrice(yesPool: number, noPool: number): number {
  const b    = 1000;
  const expY = Math.exp(yesPool / b);
  const expN = Math.exp(noPool  / b);
  return expY / (expY + expN);
}

export async function GET(req: NextRequest) {
  const now       = new Date();
  const since24h  = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const since48h  = new Date(now.getTime() + 48 * 60 * 60 * 1000); // closesAt < this → closing soon
  const since7d   = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);

  // ── Fetch all OPEN markets with 24h orders ──────────────────────────────
  const markets = await prisma.market.findMany({
    where:   { status: 'OPEN' },
    include: {
      creator: { select: { phone: true, name: true } },
      orders: {
        where:  { createdAt: { gte: since24h } },
        select: { side: true, amountKes: true, pricePerShare: true },
      },
    },
  });

  // ── Score each market ────────────────────────────────────────────────────
  const scored = markets.map((m) => {
    const yesPool    = Number(m.yesPool);
    const noPool     = Number(m.noPool);
    const currentYes = lmsrPrice(yesPool, noPool);

    // Approximate 24h-ago pools by reversing 24h orders
    let yesPool24hAgo = yesPool;
    let noPool24hAgo  = noPool;
    for (const o of m.orders) {
      const kes = Number(o.amountKes);
      if (o.side === 'YES') yesPool24hAgo -= kes;
      else                  noPool24hAgo  -= kes;
    }
    yesPool24hAgo = Math.max(yesPool24hAgo, 100);
    noPool24hAgo  = Math.max(noPool24hAgo,  100);
    const prevYes    = lmsrPrice(yesPool24hAgo, noPool24hAgo);

    const shift24h   = Math.round((currentYes - prevYes) * 100); // percentage points
    const velocity   = m.orders.length;                           // trades in 24h
    const closingSoon = m.closesAt < since48h;
    const isNew       = m.createdAt >= since7d;

    const score = (velocity * 3) + (Math.abs(shift24h) * 2) + (closingSoon ? 20 : 0) + (isNew ? 10 : 0);

    return {
      id:          m.id,
      slug:        m.slug,
      title:       m.title,
      category:    m.category,
      yes:         Math.round(currentYes * 100),
      no:          Math.round((1 - currentYes) * 100),
      yesPrice:    parseFloat(currentYes.toFixed(4)),
      noPrice:     parseFloat((1 - currentYes).toFixed(4)),
      shift24h,
      velocity,
      closingSoon,
      isNew,
      trendScore:  score,
      closesAt:    m.closesAt,
      createdAt:   m.createdAt,
      creator:     m.creator?.name ?? null,
    };
  });

  // ── Sort by score, return top 5 ──────────────────────────────────────────
  const trending = scored
    .sort((a, b) => b.trendScore - a.trendScore)
    .slice(0, 5);

  return NextResponse.json({ trending, generatedAt: now });
}
