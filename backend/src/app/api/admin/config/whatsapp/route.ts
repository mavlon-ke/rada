// src/app/api/admin/config/whatsapp/route.ts
// Admin-only endpoints to read and update the WhatsappConfig singleton.
//
// Mirrors the pattern of /api/admin/config/platform — same auth, same
// audit logging, same singleton model.
//
// Security:
//   - requireAdmin gate on both GET and POST
//   - Strict Zod validation on POST — only booleans accepted
//   - All 10 toggle fields are optional in POST; only provided fields update
//   - Audit trail via updatedByAdminId
//   - In-process cache in whatsapp-notifications.ts invalidated on every write

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';
import { invalidateWhatsappConfigCache } from '@/lib/whatsapp/whatsapp-notifications';
import { withErrorHandling } from '@/lib/security/route-guard';

export const dynamic = 'force-dynamic';

// All fields optional — admin can update one toggle at a time.
const Schema = z.object({
  globalEnabled:                     z.boolean().optional(),
  depositConfirmedEnabled:           z.boolean().optional(),
  withdrawalProcessedEnabled:        z.boolean().optional(),
  marketResolvedWonEnabled:          z.boolean().optional(),
  marketResolvedLostEnabled:         z.boolean().optional(),
  referralRewardCreditedEnabled:     z.boolean().optional(),
  refereeNominatedEnabled:           z.boolean().optional(),
  challengeOpponentStakedEnabled:    z.boolean().optional(),
  challengeResolutionWindowEnabled:  z.boolean().optional(),
  challengeResolutionWarningEnabled: z.boolean().optional(),
}).strict();  // reject unknown fields — security hygiene

// ─── GET — read current config ────────────────────────────────────────────────

export const GET = withErrorHandling(async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const config = await prisma.whatsappConfig.findUnique({
    where: { id: 'singleton' },
    include: {
      updatedByAdmin: {
        select: { id: true, name: true, email: true },
      },
    },
  });

  if (!config) {
    return NextResponse.json({ error: 'WhatsappConfig singleton not found. Seed the row first.' }, { status: 500 });
  }

  return NextResponse.json(config);
});

// ─── POST — update one or more toggles ────────────────────────────────────────

export const POST = withErrorHandling(async function POST(req: NextRequest) {
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

  // Build update object — only include keys the admin explicitly sent.
  // We don't want to overwrite untouched fields with their default values.
  const data: Record<string, any> = { ...parsed.data, updatedByAdminId: admin.id };

  // Remove undefined keys so Prisma doesn't try to set them to null.
  for (const k of Object.keys(data)) {
    if (data[k] === undefined) delete data[k];
  }

  // Nothing to update? Still treat as success (idempotent) but skip the write.
  const updateKeys = Object.keys(data).filter(k => k !== 'updatedByAdminId');
  if (updateKeys.length === 0) {
    return NextResponse.json({ success: true, message: 'No fields to update' });
  }

  const updated = await prisma.whatsappConfig.update({
    where: { id: 'singleton' },
    data,
  });

  // Invalidate the per-instance cache so this Vercel function sees the change
  // immediately. Other instances will pick it up within 60s (their cache TTL).
  invalidateWhatsappConfigCache();

  // Audit trail — what did admin change?
  await logAdminAction(
    admin.id,
    'WHATSAPP_CONFIG_UPDATED',
    'singleton',
    { changedFields: updateKeys },
  );

  return NextResponse.json({ success: true, config: updated });
});
