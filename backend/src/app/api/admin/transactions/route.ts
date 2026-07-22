// src/app/api/admin/transactions/route.ts
export const dynamic = 'force-dynamic'; // prevent Next.js caching — filters must always reach the DB

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';
import { withErrorHandling } from '@/lib/security/route-guard';

export const GET = withErrorHandling(async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const { searchParams } = new URL(req.url);
  const q      = searchParams.get('q') ?? '';
  const type   = searchParams.get('type');
  const status = searchParams.get('status');
  const page   = parseInt(searchParams.get('page') ?? '1');
  const limit  = Math.min(parseInt(searchParams.get('limit') ?? '50'), 200);

  // Support comma-separated types e.g. type=PAYOUT,CHALLENGE_PAYOUT
  const typeFilter = type
    ? type.includes(',')
      ? { in: type.split(',') as any[] }
      : type as any
    : undefined;

  // Build WHERE once — used by both findMany and count so pagination is accurate
  const where = {
    AND: [
      q ? {
        OR: [
          { mpesaRef:    { contains: q } },
          { description: { contains: q, mode: 'insensitive' as const } },
          { user: { OR: [
            { phone: { contains: q } },
            { name:  { contains: q, mode: 'insensitive' as const } },
          ]}},
        ],
      } : {},
      typeFilter ? { type: typeFilter } : {},
      status ? { status: status as any } : {},
    ],
  };

  const [txns, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      include: { user: { select: { name: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    limit,
    }),
    prisma.transaction.count({ where }),  // filtered count for correct pagination
  ]);

  return NextResponse.json({
    transactions: txns.map(t => ({
      ...t,
      amountKes: Number(t.amountKes),
      balAfter:  Number(t.balAfter),
    })),
    total, page, limit,
  });
});
