// src/app/api/admin/markets/[marketId]/route.ts
// PATCH /api/admin/markets/[marketId] — edit any field on any market

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';

const EditSchema = z.object({
  title:       z.string().min(5).max(200).optional(),
  description: z.string().min(10).max(2000).optional(),
  category:    z.enum(['GENERAL','POLITICS','ECONOMY','ENTERTAINMENT','WEATHER','TECH','FRIENDS']).optional(),
  closesAt:    z.string().datetime().optional(),
  sourceNote:  z.string().max(300).optional(),
  imageUrl:    z.string().url().optional().or(z.literal('')),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: { marketId: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const market = await prisma.market.findUnique({ where: { id: params.marketId } });
  if (!market) return NextResponse.json({ error: 'Market not found' }, { status: 404 });

  const body   = await req.json();
  const parsed = EditSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const data = parsed.data;

  // Build update payload — only include fields that were sent
  const updateData: Record<string, any> = {};
  if (data.title       !== undefined) updateData.title       = data.title;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.category    !== undefined) updateData.category    = data.category;
  if (data.sourceNote  !== undefined) updateData.sourceNote  = data.sourceNote;
  if (data.imageUrl    !== undefined) updateData.imageUrl    = data.imageUrl || null;
  if (data.closesAt    !== undefined) updateData.closesAt    = new Date(data.closesAt);

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const updated = await prisma.market.update({
    where: { id: params.marketId },
    data:  updateData,
  });

  await logAdminAction(
    admin.id,
    'MARKET_EDITED',
    market.id,
    { fields: Object.keys(updateData), title: updated.title },
    req
  );

  return NextResponse.json({ success: true, market: updated });
}
