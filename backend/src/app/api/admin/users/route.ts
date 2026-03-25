// src/app/api/admin/users/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const { searchParams } = new URL(req.url);
  const q        = searchParams.get('q') ?? '';
  const kyc      = searchParams.get('kyc');
  const page     = parseInt(searchParams.get('page') ?? '1');
  const limit    = 50;

  const users = await prisma.user.findMany({
    where: {
      AND: [
        q ? {
          OR: [
            { phone: { contains: q } },
            { name:  { contains: q, mode: 'insensitive' } },
            
          ]
        } : {},
        kyc ? { kycStatus: kyc as any } : {},
      ],
    },
    include: {
      _count: { select: { orders: true, transactions: true } },
    },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
  });

  const total = await prisma.user.count();

  // Enrich with trade volume
  const enriched = await Promise.all(users.map(async u => {
    const vol = await prisma.order.aggregate({
      where: { userId: u.id, status: 'FILLED' },
      _sum: { amountKes: true },
    });
    return {
      ...u,
      balanceKes:  Number(u.balanceKes),
      tradeVolume: Math.abs(Number(vol._sum.amountKes ?? 0)),
      tradeCount:  u._count.orders,
    };
  }));

  return NextResponse.json({ users: enriched, total, page, limit });
}
