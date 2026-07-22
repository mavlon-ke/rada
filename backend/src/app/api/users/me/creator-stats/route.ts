// src/app/api/users/me/creator-stats/route.ts
// Returns the authenticated user's creator activity:
//   - summary: this-month, live-markets count, total-earned (lifetime)
//   - items: unified array of markets they created (live/closed/resolved)
//            + their pending and rejected proposals, newest-first.
// Drives the "My Creator Markets" table and the BOUNTY_STATS panel on
// rada-creator.html. Returns ALL items (no pagination); a creator with
// hundreds of items is unrealistic for the foreseeable future, and table
// rendering is fast for ≤100 rows.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/security/route-guard';

export const GET = withErrorHandling(async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // ── Fetch user's markets (regardless of status) and all their proposals
  //    in parallel — three queries, all index-supported.
  const [markets, proposals, creatorBounties] = await Promise.all([
    prisma.market.findMany({
      where:   { creatorId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id:          true,
        slug:        true,
        title:       true,
        category:    true,
        status:      true,
        totalVolume: true,
        closesAt:    true,
        createdAt:   true,
      },
    }),
    prisma.marketProposal.findMany({
      where:   { proposerId: user.id, status: { in: ['PENDING', 'REJECTED'] } },
      orderBy: { createdAt: 'desc' },
      select: {
        id:              true,
        question:        true,
        category:        true,
        status:          true,
        createdAt:       true,
        rejectionReason: true,
      },
    }),
    prisma.creatorBounty.findMany({
      where: { creatorId: user.id },
      select: {
        marketId:     true,
        bountyEarned: true,
        paidOut:      true,
      },
    }),
  ]);

  // ── Build a marketId -> bounty lookup for joining
  const bountyByMarket = new Map<string, { earned: number; paid: number }>();
  for (const b of creatorBounties) {
    bountyByMarket.set(b.marketId, {
      earned: Number(b.bountyEarned),
      paid:   Number(b.paidOut),
    });
  }

  // ── Compute summary stats
  // "This month" = calendar month in UTC. We rely on the bounty.bountyEarned
  // running total only for lifetime; for this-month we sum CREATOR_ROYALTY_PAID
  // PlatformRevenue rows (which carry timestamps) in the current month.
  // CREATOR_ROYALTY_PAID amounts are stored as negatives — abs() them for display.
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const thisMonthRows = await prisma.platformRevenue.findMany({
    where: {
      type:      'CREATOR_ROYALTY_PAID',
      createdAt: { gte: monthStart },
      market:    { creatorId: user.id },
    },
    select: { amountKes: true },
  });
  const thisMonthEarnedKes = thisMonthRows.reduce(
    (sum, row) => sum + Math.abs(Number(row.amountKes)),
    0
  );

  const totalEarnedKes = creatorBounties.reduce(
    (sum, b) => sum + Number(b.bountyEarned),
    0
  );

  const liveMarketsCount = markets.filter((m) => m.status === 'OPEN').length;

  // ── Build the unified items array. Sort by createdAt desc across all kinds.
  type Item =
    | { kind: 'approved'; createdAt: Date; payload: any }
    | { kind: 'pending';  createdAt: Date; payload: any }
    | { kind: 'rejected'; createdAt: Date; payload: any };

  const items: Item[] = [];

  for (const m of markets) {
    const b = bountyByMarket.get(m.id) ?? { earned: 0, paid: 0 };
    items.push({
      kind:      'approved',
      createdAt: m.createdAt,
      payload: {
        kind:            'approved',
        marketId:        m.id,
        slug:            m.slug,
        title:           m.title,
        category:        m.category,
        status:          m.status,
        totalVolumeKes:  Number(m.totalVolume),
        bountyEarnedKes: b.earned,
        bountyPaidKes:   b.paid,
        closesAt:        m.closesAt,
        createdAt:       m.createdAt,
      },
    });
  }

  for (const p of proposals) {
    items.push({
      kind:      p.status === 'PENDING' ? 'pending' : 'rejected',
      createdAt: p.createdAt,
      payload: {
        kind:            p.status === 'PENDING' ? 'pending' : 'rejected',
        proposalId:      p.id,
        title:           p.question,
        category:        p.category,
        rejectionReason: p.rejectionReason,
        createdAt:       p.createdAt,
      },
    });
  }

  items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return NextResponse.json({
    summary: {
      totalEarnedKes,
      thisMonthEarnedKes,
      liveMarketsCount,
    },
    items: items.map((it) => it.payload),
  });
});
