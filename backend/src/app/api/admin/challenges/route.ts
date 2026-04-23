// src/app/api/admin/challenges/route.ts
// GET /api/admin/challenges — list challenges by status for admin dispute desk

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status') || 'DISPUTED';

  const challenges = await prisma.marketChallenge.findMany({
    where:   status === 'ALL' ? {} : { status: status as any },
    include: {
      userA:   { select: { id: true, name: true, phone: true } },
      userB:   { select: { id: true, name: true, phone: true } },
      referee: { select: { id: true, name: true, phone: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const enriched = challenges.map(function(c) {
    const pool    = Number(c.totalPool);
    const fee15   = Math.round(pool * 0.15);
    const fee5    = Math.round(pool * Number(c.feePercent) / 100);
    const expired = c.disputeDeadline
      ? Math.round((Date.now() - new Date(c.disputeDeadline).getTime()) / 3600000)
      : null;
    return {
      id:           c.id,
      question:     c.question,
      status:       c.status,
      userA:        c.userA  ? (c.userA.name  || c.userA.phone)  : 'User A',
      userAId:      c.userAId,
      userB:        c.userB  ? (c.userB.name  || c.userB.phone)  : 'User B',
      userBId:      c.userBId,
      referee:      c.referee ? (c.referee.name || c.referee.phone) : null,
      pool,
      fee15,
      fee5,
      totalPool: pool,
      stakeEach:    Number(c.stakePerPerson),
      validatorType: c.validatorType,
      userAConfirm: c.userAConfirm,
      userBConfirm: c.userBConfirm,
      expiredHoursAgo: expired,
      eventExpiresAt:  c.eventExpiresAt,
      createdAt:       c.createdAt,
    };
  });

  return NextResponse.json({ challenges: enriched, total: enriched.length });
}
