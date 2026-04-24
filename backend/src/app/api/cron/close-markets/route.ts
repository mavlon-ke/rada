// src/app/api/cron/close-markets/route.ts
// Auto-close markets whose closesAt has passed and are still OPEN.
//
// Railway Cron setup:
//   Schedule : */30 * * * *
//   URL      : GET https://api.checkrada.co.ke/api/cron/close-markets?secret=YOUR_CRON_SECRET
//
// No custom headers needed — Railway cron supports plain GET with query params.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

async function runCloseMarkets() {
  const now = new Date();

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
    return { success: true, closed: 0, timestamp: now.toISOString() };
  }

  const closed: string[] = [];
  const errors:  string[] = [];

  for (const market of expired) {
    try {
      await prisma.market.update({
        where: { id: market.id },
        data:  { status: 'CLOSED' },
      });
      closed.push(market.id);
    } catch (err) {
      errors.push(`${market.id}: ${(err as Error).message}`);
    }
  }

  return {
    success:   true,
    found:     expired.length,
    closed:    closed.length,
    errors,
    marketIds: closed,
    timestamp: now.toISOString(),
  };
}

function checkSecret(req: NextRequest): boolean {
  // Vercel Cron sends: Authorization: Bearer <CRON_SECRET>
  const authHeader   = req.headers.get('authorization');
  const bearerSecret = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  // Backward compat: also accept x-cron-secret header or ?secret= query param
  const headerSecret = req.headers.get('x-cron-secret');
  const querySecret  = new URL(req.url).searchParams.get('secret');
  const provided     = bearerSecret ||  headerSecret  || querySecret;
  return !!provided && provided === process.env.CRON_SECRET;
}

export async function GET(req: NextRequest) {
  if (!checkSecret(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    return NextResponse.json(await runCloseMarkets());
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!checkSecret(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    return NextResponse.json(await runCloseMarkets());
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
