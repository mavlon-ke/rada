// src/app/api/cron/close-markets/route.ts
// POST — auto-close markets whose closesAt has passed and are still OPEN
// Call every 30 minutes via Railway Cron: */30 * * * *
// Secure with CRON_SECRET header: x-cron-secret

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

export async function POST(req: NextRequest) {
  // ── Auth ─────────────────────────────────────────────────────────────────
  const secret = req.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const now = new Date();

  // ── Find OPEN markets past their closesAt ─────────────────────────────────
  const expired = await prisma.market.findMany({
    where: {
      status:   'OPEN',
      closesAt: { lte: now },
    },
    select: {
      id:          true,
      title:       true,
      closesAt:    true,
      totalVolume: true,
    },
  });

  if (!expired.length) {
    return NextResponse.json({ success: true, closed: 0, timestamp: now.toISOString() });
  }

  // ── Close each market ─────────────────────────────────────────────────────
  const closed: string[] = [];
  const errors:  string[] = [];

  for (const market of expired) {
    try {
      await prisma.market.update({
        where: { id: market.id },
        data:  { status: 'CLOSED' },
      });

      // No AdminActivityLog insert (requires FK to AdminAccount).
      // The admin Pending Resolution widget picks up CLOSED markets automatically.

      closed.push(market.id);
    } catch (err) {
      errors.push(`${market.id}: ${(err as Error).message}`);
    }
  }

  return NextResponse.json({
    success:   true,
    found:     expired.length,
    closed:    closed.length,
    errors,
    marketIds: closed,
    timestamp: now.toISOString(),
  });
}

// Also allow GET for easy health check / manual trigger from browser
export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret') || new URL(req.url).searchParams.get('secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return POST(req);
}
