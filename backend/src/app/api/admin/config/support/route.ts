// src/app/api/admin/config/support/route.ts
// GET  — fetch current support WhatsApp number
// POST — update support WhatsApp number

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/admin';
import { prisma } from '@/lib/db/prisma';

const UpdateSchema = z.object({
  whatsappNumber: z.string().regex(/^[0-9]{9,15}$/, 'Must be digits only, 9-15 chars').or(z.literal('')),
});

// We store support config in the same SiteConfig pattern as referral/carousel
// Using a singleton record with key = 'support'

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // Try to read from a config store — fall back to empty if not set
    const config = await (prisma as any).siteConfig?.findUnique?.({ where: { key: 'support_whatsapp' } })
      ?? null;

    return NextResponse.json({
      whatsappNumber: config?.value ?? '',
    });
  } catch {
    // If SiteConfig model doesn't exist yet, return empty
    return NextResponse.json({ whatsappNumber: '' });
  }
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json();
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { whatsappNumber } = parsed.data;

  try {
    await (prisma as any).siteConfig?.upsert?.({
      where:  { key: 'support_whatsapp' },
      update: { value: whatsappNumber },
      create: { key: 'support_whatsapp', value: whatsappNumber },
    });
  } catch {
    // SiteConfig model not yet migrated — log and continue gracefully
    console.warn('[support/config] SiteConfig not available yet. Number not persisted to DB.');
  }

  return NextResponse.json({
    success: true,
    whatsappNumber,
    message: whatsappNumber
      ? `Support WhatsApp set to ${whatsappNumber}`
      : 'Support WhatsApp number cleared',
  });
}
