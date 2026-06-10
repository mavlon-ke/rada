// src/app/api/cron/close-markets/route.ts
// Auto-close markets whose closesAt has passed and are still OPEN.
// Fires admin WhatsApp alert for each market closed, so admin knows
// which markets need resolving.
//
// Railway Cron setup (primary — runs every 30 min):
//   Schedule : */30 * * * *
//   URL      : GET https://api.checkrada.co.ke/api/cron/close-markets?secret=YOUR_CRON_SECRET
//
// Vercel Cron setup (backup — runs daily at 2am UTC, configured in vercel.json):
//   Path     : /api/cron/close-markets
//   Schedule : 0 2 * * *
//
// Both are active. Railway provides frequent checks; Vercel is the safety net.
// Auth accepts Authorization: Bearer <CRON_SECRET>, x-cron-secret header,
// or ?secret= query param for backward compatibility with both callers.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { sendAdminAlert } from '@/lib/whatsapp/admin-alerts';

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
      _count: {
        select: {
          orders:    true,  // trade count
          positions: true,  // unique trader count
        },
      },
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

      // Fire admin WhatsApp alert — fire-and-forget, never throws
      void sendAdminAlert('ADMIN_MARKET', [
        { name: 'market_title',   value: market.title.slice(0, 100) },
        { name: 'trader_count',   value: String(market._count.positions) },
        { name: 'amount_staked',  value: Math.round(Number(market.totalVolume)).toLocaleString() },
      ]);

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
  const authHeader   = req.headers.get('authorization');
  const bearerSecret = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const headerSecret = req.headers.get('x-cron-secret');
  const querySecret  = new URL(req.url).searchParams.get('secret');
  const provided     = bearerSecret || headerSecret || querySecret;
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
