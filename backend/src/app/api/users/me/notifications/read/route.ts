// src/app/api/users/me/notifications/read/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/security/route-guard';

// PATCH — mark all notifications as read
export const PATCH = withErrorHandling(async function PATCH(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await prisma.notification.updateMany({
    where: { userId: user.id, read: false },
    data:  { read: true },
  });

  return NextResponse.json({ success: true });
});
