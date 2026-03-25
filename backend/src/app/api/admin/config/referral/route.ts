// src/app/api/admin/config/referral/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';
import { z } from 'zod';

const ConfigSchema = z.object({
  active:            z.boolean(),
  referrerRewardKes: z.number().min(0).max(10000),
  refereeMatchKes:   z.number().min(0).max(10000),
  minDepositKes:     z.number().min(0).max(10000),
});

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  let config = await prisma.referralConfig.findUnique({ where: { id: 'singleton' } });
  if (!config) {
    config = await prisma.referralConfig.create({ data: { id: 'singleton' } });
  }
  return NextResponse.json({ config });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const body   = await req.json();
  const parsed = ConfigSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const config = await prisma.referralConfig.upsert({
    where:  { id: 'singleton' },
    create: { id: 'singleton', ...parsed.data },
    update: parsed.data,
  });

  return NextResponse.json({ config });
}
