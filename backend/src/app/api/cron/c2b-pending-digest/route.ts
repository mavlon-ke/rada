// backend/src/app/api/cron/c2b-pending-digest/route.ts
//
// Safety net — the single WhatsApp alert fired at receipt can get missed.
// This catches anything still PENDING after 6 hours and sends one summary
// alert rather than re-alerting per row.
//
// SCHEDULE NOTE: registered in vercel.json as a single once-daily run
// ("0 8 * * *"). Confirmed this project is on Vercel's Hobby plan, which
// only allows cron jobs to fire once per day — a twice-daily expression
// would fail at deploy time. If this project ever moves to Pro, this can
// safely move to twice-daily.
//
// Exports both GET (Vercel's own scheduler invokes via GET) and POST
// (for an external pinger, matching the dual-trigger pattern already used
// by close-markets and cleanup-notifications).

import { NextRequest, NextResponse } from 'next/server';
import { prisma }                    from '@/lib/db/prisma';
import { withErrorHandling }         from '@/lib/security/route-guard';
import { sendAdminAlert }            from '@/lib/whatsapp/admin-alerts';

export const dynamic = 'force-dynamic';

function checkSecret(req: NextRequest): boolean {
  const provided =
    req.headers.get('authorization')?.replace('Bearer ', '') ??
    req.nextUrl.searchParams.get('secret');
  return provided === process.env.CRON_SECRET;
}

async function runDigest(req: NextRequest): Promise<NextResponse> {
  if (!checkSecret(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

  const stale = await prisma.transaction.findMany({
    where: { type: 'DEPOSIT', userId: null, status: 'PENDING', createdAt: { lt: sixHoursAgo } },
  });

  if (stale.length === 0) {
    return NextResponse.json({ success: true, pending: 0 });
  }

  const totalKes = stale.reduce((sum, t) => sum + Number(t.amountKes), 0);

  void sendAdminAlert('ADMIN_BALANCE', [
    { name: 'user_name', value: `${stale.length} unmatched Paybill deposit(s) awaiting review` },
    { name: 'amount',    value: `KES ${totalKes.toLocaleString()} total` },
  ]);

  return NextResponse.json({ success: true, pending: stale.length, totalKes });
}

export const GET  = withErrorHandling(async (req: NextRequest) => runDigest(req));
export const POST = withErrorHandling(async (req: NextRequest) => runDigest(req));
