// src/app/api/admin/referrals/route.ts
// Paginated list of all referral records for the admin referral panel.
// Returns referrer + referee identity (full phone — admin context) and reward status.
//
// Query params:
//   page   — page number (default: 1)
//   limit  — records per page (default: 20, max: 100)
//   q      — search by referrer or referee phone/name
//   status — filter by ReferralStatus: PENDING | QUALIFIED | REWARDED | FLAGGED

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const sp     = new URL(req.url).searchParams;
  const page   = Math.max(1, parseInt(sp.get('page')  ?? '1')  || 1);
  const limit  = Math.min(parseInt(sp.get('limit') ?? '20') || 20, 100);
  const q      = (sp.get('q') ?? '').trim();
  const status = (sp.get('status') ?? '').trim();

  const where = {
    AND: [
      status ? { status: status as any } : {},
      q ? {
        OR: [
          { referrer: { phone: { contains: q } } },
          { referrer: { name:  { contains: q, mode: 'insensitive' as const } } },
          { referee:  { phone: { contains: q } } },
          { referee:  { name:  { contains: q, mode: 'insensitive' as const } } },
        ],
      } : {},
    ],
  };

  const [referrals, total] = await Promise.all([
    prisma.referral.findMany({
      where,
      include: {
        referrer: { select: { id: true, name: true, phone: true } },
        referee:  { select: { id: true, name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    limit,
    }),
    prisma.referral.count({ where }),
  ]);

  return NextResponse.json({
    referrals: referrals.map(r => ({
      id:                r.id,
      status:            r.status,
      referrer:          r.referrer,
      referee:           r.referee,
      referrerRewardKes: Number(r.referrerRewardKes),
      refereeRewardKes:  Number(r.refereeRewardKes),
      rewardPaidAt:      r.rewardPaidAt,
      createdAt:         r.createdAt,
    })),
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  });
}
