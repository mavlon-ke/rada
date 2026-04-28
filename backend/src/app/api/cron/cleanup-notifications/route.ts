// src/app/api/cron/cleanup-notifications/route.ts
// Hard-deletes notifications older than 180 days.
//
// Vercel Cron setup (configured in vercel.json):
//   Schedule : 0 4 * * *   (daily at 4 AM UTC)
//   Path     : /api/cron/cleanup-notifications
//
// Auth: same pattern as close-markets — accepts Authorization: Bearer <CRON_SECRET>,
// x-cron-secret header, or ?secret=... query param.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

const RETENTION_DAYS = 180;

async function runCleanupNotifications() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  const result = await prisma.notification.deleteMany({
    where: {
      createdAt: { lt: cutoff },
    },
  });

  return {
    success: true,
    deleted: result.count,
    cutoff: cutoff.toISOString(),
    timestamp: new Date().toISOString(),
  };
}

function checkSecret(req: NextRequest): boolean {
  // Vercel Cron sends: Authorization: Bearer <CRON_SECRET>
  const authHeader   = req.headers.get('authorization');
  const bearerSecret = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  // Backward compat: also accept x-cron-secret header or ?secret= query param
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
    return NextResponse.json(await runCleanupNotifications());
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!checkSecret(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    return NextResponse.json(await runCleanupNotifications());
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
