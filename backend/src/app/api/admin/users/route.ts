// src/app/api/admin/users/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  try {
    const { searchParams } = new URL(req.url);
    const q     = searchParams.get('q') ?? '';
    const kyc   = searchParams.get('kyc');
    const page  = parseInt(searchParams.get('page') ?? '1');
    const limit = 50;

    // 1. Fetch users — explicit select avoids schema-drift errors on
    //    columns that exist in schema.prisma but not yet in the production DB.
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
      select: {
        id:              true,
        phone:           true,
        name:            true,
        kycStatus:       true,
        role:            true,
        balanceKes:      true,
        bonusBalanceKes: true,
        suspended:       true,
        agreedToTerms:   true,
        integrityScore:  true,
        referralCode:    true,
        createdAt:       true,
        _count: { select: { orders: true, transactions: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    limit,
    });

    const [total, volumeRows] = await Promise.all([
      // 2. Total count — single query
      prisma.user.count(),

      // 3. Trade volumes — ONE grouped query instead of N individual aggregates.
      //    Previously this was Promise.all(users.map(...aggregate...)) which fired
      //    up to 50 concurrent DB connections, exhausting Supabase's connection
      //    pool and causing intermittent 500s.
      prisma.order.groupBy({
        by:     ['userId'],
        where:  {
          userId: { in: users.map(u => u.id) },
          status: 'FILLED',
        },
        _sum:   { amountKes: true },
      }),
    ]);

    // Build a userId → volume lookup map
    const volMap = new Map<string, number>();
    for (const row of volumeRows) {
      volMap.set(row.userId, Math.abs(Number(row._sum.amountKes ?? 0)));
    }

    const enriched = users.map(u => ({
      ...u,
      balanceKes:  Number(u.balanceKes),
      tradeVolume: volMap.get(u.id) ?? 0,
      tradeCount:  u._count.orders,
    }));

    return NextResponse.json({ users: enriched, total, page, limit });

  } catch (err: any) {
    console.error('[admin/users] GET error:', err?.message ?? err);
    return NextResponse.json(
      { error: 'Failed to load users', detail: err?.message },
      { status: 500 }
    );
  }
}
