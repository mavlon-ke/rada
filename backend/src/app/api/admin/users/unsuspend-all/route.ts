// Emergency: unsuspend ALL users at once
// GET /api/admin/users/unsuspend-all?secret=CRON_SECRET

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

export async function GET(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get('secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const result = await prisma.user.updateMany({
    where: { suspended: true },
    data:  { suspended: false },
  });

  return NextResponse.json({
    success: true,
    unsuspended: result.count,
    message: result.count > 0
      ? `${result.count} user(s) unsuspended.`
      : 'No suspended users found.',
  });
}
