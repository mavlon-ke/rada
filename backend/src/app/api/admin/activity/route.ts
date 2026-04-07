// src/app/api/admin/activity/route.ts
// GET /api/admin/activity — recent admin activity log entries

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 200);

  const logs = await prisma.adminActivityLog.findMany({
    include: { admin: { select: { name: true, email: true } } },
    orderBy: { createdAt: 'desc' },
    take:    limit,
  });

  return NextResponse.json({
    logs: logs.map(l => ({
      id:        l.id,
      admin:     l.admin?.name || l.admin?.email || 'Admin',
      action:    l.action,
      target:    l.target || '—',
      detail:    l.detail,
      ipAddress: l.ipAddress || '—',
      createdAt: l.createdAt,
    })),
    total: logs.length,
  });
}
