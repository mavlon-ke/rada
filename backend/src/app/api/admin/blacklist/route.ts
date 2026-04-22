// src/app/api/admin/blacklist/route.ts
// GET    — list all blacklisted numbers
// POST   — add a number to the blacklist manually
// DELETE — remove a number from the blacklist

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';
import { normaliseToE164 } from '@/lib/whatsapp/whatsapp-otp';

export const dynamic = 'force-dynamic';

// GET — return all blacklisted numbers
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const entries = await prisma.blacklist.findMany({
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ entries, count: entries.length });
}

// POST — manually add a phone number to the blacklist
const AddSchema = z.object({
  phone:  z.string().min(5).max(20),
  reason: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const body   = await req.json();
  const parsed = AddSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const phone = normaliseToE164(parsed.data.phone) ?? parsed.data.phone;

  const entry = await prisma.blacklist.upsert({
    where:  { phone },
    create: { phone, reason: parsed.data.reason, createdByAdminId: admin.id },
    update: { reason: parsed.data.reason, createdByAdminId: admin.id },
  });

  await logAdminAction(admin.id, 'BLACKLIST_ADDED', phone, { reason: parsed.data.reason }, req);

  return NextResponse.json({ success: true, entry });
}

// DELETE — remove a number from the blacklist
const RemoveSchema = z.object({ phone: z.string() });

export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const body   = await req.json();
  const parsed = RemoveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Phone number required' }, { status: 400 });
  }

  const existing = await prisma.blacklist.findUnique({ where: { phone: parsed.data.phone } });
  if (!existing) {
    return NextResponse.json({ error: 'Number not found in blacklist' }, { status: 404 });
  }

  await prisma.blacklist.delete({ where: { phone: parsed.data.phone } });

  await logAdminAction(admin.id, 'BLACKLIST_REMOVED', parsed.data.phone, {}, req);

  return NextResponse.json({ success: true, message: `${parsed.data.phone} removed from blacklist.` });
}
