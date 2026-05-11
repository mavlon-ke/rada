// src/app/api/users/me/notifications/[id]/read/route.ts
// PATCH — mark a single notification as read.
// Used when the user taps a single notification in the bell tray, so the
// unread badge decrements by exactly 1 instead of waiting for "Mark all read".
//
// Returns the new unreadCount so the frontend can update the badge without
// a full reload of the notifications list.
//
// Auth: same pattern as the rest of /api/users/me/* — JWT bearer token.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Update the notification ONLY if it belongs to this user AND is currently
  // unread. updateMany is used (not update) because:
  //   1. Atomic single SQL statement — no read-then-write race.
  //   2. Forbids cross-user reads (sending another user's id won't touch their data).
  //   3. Idempotent — calling twice on already-read notification returns count=0.
  //   4. Doesn't throw if the id doesn't exist (no try/catch needed for 404).
  const result = await prisma.notification.updateMany({
    where: {
      id:     params.id,
      userId: user.id,
      read:   false,
    },
    data: { read: true },
  });

  // Compute the new unread count so the frontend badge updates from the
  // authoritative server-side value (no drift from optimistic-update bugs).
  const unreadCount = await prisma.notification.count({
    where: { userId: user.id, read: false },
  });

  return NextResponse.json({
    success:     true,
    updated:     result.count,  // 0 if already read or not found, 1 if newly marked read
    unreadCount,
  });
}
