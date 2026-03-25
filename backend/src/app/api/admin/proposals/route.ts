// src/app/api/admin/proposals/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status') ?? 'PENDING';

  const proposals = await prisma.marketProposal.findMany({
    where:   status === 'ALL' ? {} : { status: status as any },
    include: { proposer: { select: { phone: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ proposals });
}
