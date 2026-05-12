// src/app/api/admin/users/[userId]/whatsapp-optout/route.ts
// Admin-only endpoint to mark or unmark a user as opted-out from WhatsApp
// notifications.
//
// Used when a user replies "STOP" to a WhatsApp template message — admin
// reviews the Meta Business inbox manually and marks affected users here.
//
// Security:
//   - requireAdmin gate
//   - userId is a path parameter, validated by Prisma's where clause
//   - boolean payload only; Zod .strict() rejects unknown fields
//   - audit trail via logAdminAction with userId in target

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';

const Schema = z.object({
  optedOut: z.boolean(),
}).strict();

export async function POST(
  req: NextRequest,
  { params }: { params: { userId: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Verify user exists before updating (Prisma's update would throw P2025
  // otherwise — return a cleaner 404 instead).
  const exists = await prisma.user.findUnique({
    where:  { id: params.userId },
    select: { id: true, phone: true, whatsappOptedOut: true },
  });

  if (!exists) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // No-op if state already matches — keeps logs clean of duplicate actions.
  if (exists.whatsappOptedOut === parsed.data.optedOut) {
    return NextResponse.json({
      success:  true,
      message:  'No change',
      optedOut: exists.whatsappOptedOut,
    });
  }

  await prisma.user.update({
    where: { id: params.userId },
    data:  { whatsappOptedOut: parsed.data.optedOut },
  });

  await logAdminAction(
    admin.id,
    parsed.data.optedOut ? 'USER_WHATSAPP_OPTOUT_SET' : 'USER_WHATSAPP_OPTOUT_CLEARED',
    `user:${params.userId}`,
    { optedOut: parsed.data.optedOut },
  );

  return NextResponse.json({
    success:  true,
    userId:   params.userId,
    optedOut: parsed.data.optedOut,
  });
}
