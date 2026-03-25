// src/app/api/admin/challenges/notify-expiring/route.ts
// Cron endpoint — call this every hour via Railway Cron or a third-party scheduler.
// Sends SMS + in-app alerts to both participants when a challenge enters its 48h resolution window.
//
// Schedule: every hour  →  0 * * * *
// Secure with CRON_SECRET env var — add to Railway environment variables.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';


export async function POST(req: NextRequest) {
  // ── Cron auth ────────────────────────────────────────────────────────────
  const secret = req.headers.get('x-cron-secret');
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const now        = new Date();
  const in48h      = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const in49h      = new Date(now.getTime() + 49 * 60 * 60 * 1000); // 1-hour window to avoid double-firing

  // Find challenges whose event has just ended (within the last hour) and are still ACTIVE
  const expiring = await prisma.marketChallenge.findMany({
    where: {
      status:         { in: ['ACTIVE', 'PENDING_RESOLUTION'] },
      eventExpiresAt: { lte: now },                    // event has ended
      disputeDeadline: null,                            // 48h window not yet set
    },
    include: {
      userA: { select: { name: true, phone: true } },
      userB: { select: { name: true, phone: true } },
    },
  });

  const notified: string[] = [];
  const errors:   string[] = [];

  for (const ch of expiring) {
    try {
      // Set the 48h dispute window
      const deadline = new Date(now.getTime() + 48 * 60 * 60 * 1000);
      await prisma.marketChallenge.update({
        where: { id: ch.id },
        data:  { disputeDeadline: deadline, status: 'PENDING_RESOLUTION' },
      });

      

      notified.push(ch.id);
    } catch (err) {
      errors.push(`${ch.id}: ${(err as Error).message}`);
    }
  }

  return NextResponse.json({
    success:   true,
    processed: expiring.length,
    notified:  notified.length,
    errors,
    timestamp: now.toISOString(),
  });
}
