// src/app/api/admin/proposals/[id]/route.ts
// PATCH /api/admin/proposals/[id] — edit a proposal (question, category, source, note)

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';

const Schema = z.object({
  question:         z.string().min(10).max(300).optional(),
  category:         z.enum(['GENERAL','POLITICS','ECONOMY','ENTERTAINMENT','WEATHER','TECH','FRIENDS']).optional(),
  resolutionSource: z.string().min(5).max(300).optional(),
  whyCareNote:      z.string().max(500).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const proposal = await prisma.marketProposal.findUnique({ where: { id: params.id } });
  if (!proposal) return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });

  const body   = await req.json();
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const data: Record<string, any> = {};
  if (parsed.data.question         !== undefined) data.question         = parsed.data.question;
  if (parsed.data.category         !== undefined) data.category         = parsed.data.category;
  if (parsed.data.resolutionSource !== undefined) data.resolutionSource = parsed.data.resolutionSource;
  if (parsed.data.whyCareNote      !== undefined) data.whyCareNote      = parsed.data.whyCareNote;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const updated = await prisma.marketProposal.update({
    where: { id: params.id },
    data,
  });

  await logAdminAction(
    admin.id, 'PROPOSAL_EDITED', params.id,
    { fields: Object.keys(data) },
    req
  );

  return NextResponse.json({ success: true, proposal: updated });
}
