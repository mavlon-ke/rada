// src/app/api/admin/proposals/[id]/reject/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';

const Schema = z.object({ reason: z.string().optional() });

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const body   = await req.json().catch(() => ({}));
  const parsed = Schema.safeParse(body);

  const proposal = await prisma.marketProposal.findUnique({ where: { id: params.id } });
  if (!proposal)                    return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
  if (proposal.status !== 'PENDING') return NextResponse.json({ error: 'Already processed' }, { status: 400 });

  await prisma.marketProposal.update({
    where: { id: proposal.id },
    data:  { status: 'REJECTED', rejectionReason: parsed.success ? parsed.data.reason : undefined },
  });

  await logAdminAction(admin.id, 'PROPOSAL_REJECTED', `proposal:${proposal.id}`, {
    question: proposal.question,
    reason: parsed.success ? parsed.data.reason : undefined,
  }, req);

  return NextResponse.json({ success: true });
}
