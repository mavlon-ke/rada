// src/app/api/admin/transactions/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const { searchParams } = new URL(req.url);
  const q      = searchParams.get('q') ?? '';
  const type   = searchParams.get('type');
  const status = searchParams.get('status');
  const page   = parseInt(searchParams.get('page') ?? '1');
  const limit  = 50;

  const txns = await prisma.transaction.findMany({
    where: {
      AND: [
        q ? {
          OR: [
            { mpesaRef:   { contains: q } },
            { description:{ contains: q, mode: 'insensitive' } },
            { user: { OR: [
              { phone: { contains: q } },
              { name:  { contains: q, mode: 'insensitive' } },
            ]}},
          ],
        } : {},
        type   ? { type:   type   as any } : {},
        status ? { status: status as any } : {},
      ],
    },
    include: { user: { select: { name: true, phone: true } } },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
  });

  const total = await prisma.transaction.count();

  return NextResponse.json({
    transactions: txns.map(t => ({
      ...t,
      amountKes: Number(t.amountKes),
      balAfter:  Number(t.balAfter),
    })),
    total, page, limit,
  });
}
