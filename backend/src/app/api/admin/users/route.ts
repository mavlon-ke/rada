// src/app/api/admin/users/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';
import { withErrorHandling } from '@/lib/security/route-guard';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  try {
    const { searchParams } = new URL(req.url);
    const q         = searchParams.get('q') ?? '';
    const kyc       = searchParams.get('kyc');
    const suspended = searchParams.get('suspended'); // 'true' | 'false' | null
    const page      = Math.max(1, parseInt(searchParams.get('page')  ?? '1') || 1);
    const limit     = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') ?? '50') || 50));

    const where: any = {
      AND: [
        q ? {
          OR: [
            { phone: { contains: q } },
            { name:  { contains: q, mode: 'insensitive' } },
          ]
        } : {},
        kyc       ? { kycStatus: kyc as any }   : {},
        suspended === 'true'  ? { suspended: true  } :
        suspended === 'false' ? { suspended: false } : {},
      ],
    };

    // findMany and count share the same where — run in parallel
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
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
      }),
      prisma.user.count({ where }),
    ]);

    // Single groupBy for trade volumes — one query not N
    const volumeRows = await prisma.order.groupBy({
      by:    ['userId'],
      where: { userId: { in: users.map(u => u.id) }, status: 'FILLED' },
      _sum:  { amountKes: true },
    });

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
});
