// src/app/api/admin/config/platform/route.ts
// Admin-only endpoints for reading and updating PlatformConfig.
//
// Hard caps (defence-in-depth):
//   creatorRoyaltyRate         <= 0.05   (5% — also enforced in trade route)
//   creatorRoyaltyThresholdKes <= 1_000_000
//   suggestionRewardKes        <= 10_000
//   bountyMinPayoutKes         <= 10_000
//
// Out-of-range values are HARD-REJECTED (per platform decision E).
//
// updatedByAdminId stamped on every successful update for audit trail.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';
import { withErrorHandling } from '@/lib/security/route-guard';

export const dynamic = 'force-dynamic';

const ConfigSchema = z.object({
  forecastingFeeRate:         z.number().min(0),
  resolutionCutRate:          z.number().min(0),
  creatorRoyaltyRate:         z.number().min(0).max(0.05),
  creatorRoyaltyThresholdKes: z.number().min(0).max(1_000_000),
  creatorProgrammeActive:     z.boolean(),
  suggestionRewardKes:        z.number().min(0).max(10_000),
  bountyMinPayoutKes:         z.number().min(0).max(10_000),
});

export const GET = withErrorHandling(async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  let config = await prisma.platformConfig.findUnique({
    where:   { id: 'singleton' },
    include: { updatedByAdmin: { select: { name: true, email: true } } },
  });

  if (!config) {
    // Defensive: re-create the singleton if somehow missing.
    config = await prisma.platformConfig.create({
      data:    { id: 'singleton' },
      include: { updatedByAdmin: { select: { name: true, email: true } } },
    });
  }

  return NextResponse.json({
    config: {
      forecastingFeeRate:         Number(config.forecastingFeeRate),
      resolutionCutRate:          Number(config.resolutionCutRate),
      creatorRoyaltyRate:         Number(config.creatorRoyaltyRate),
      creatorRoyaltyThresholdKes: Number(config.creatorRoyaltyThresholdKes),
      creatorProgrammeActive:     config.creatorProgrammeActive,
      suggestionRewardKes:        Number(config.suggestionRewardKes),
      bountyMinPayoutKes:         Number(config.bountyMinPayoutKes),
      updatedAt:                  config.updatedAt,
      updatedByAdminId:           config.updatedByAdminId,
      updatedByAdminName:         config.updatedByAdmin?.name ?? null,
    },
  });
});

export const POST = withErrorHandling(async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = ConfigSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({
      error:   'Validation failed',
      details: parsed.error.flatten(),
    }, { status: 400 });
  }

  const data = parsed.data;

  const config = await prisma.platformConfig.upsert({
    where:  { id: 'singleton' },
    create: { id: 'singleton', ...data, updatedByAdminId: admin.id },
    update: { ...data, updatedByAdminId: admin.id },
  });

  await logAdminAction(admin.id, 'PLATFORM_CONFIG_UPDATED', 'platform_config:singleton', {
    forecastingFeeRate:         data.forecastingFeeRate,
    resolutionCutRate:          data.resolutionCutRate,
    creatorRoyaltyRate:         data.creatorRoyaltyRate,
    creatorRoyaltyThresholdKes: data.creatorRoyaltyThresholdKes,
    creatorProgrammeActive:     data.creatorProgrammeActive,
    suggestionRewardKes:        data.suggestionRewardKes,
    bountyMinPayoutKes:         data.bountyMinPayoutKes,
  }, req);

  return NextResponse.json({
    config: {
      forecastingFeeRate:         Number(config.forecastingFeeRate),
      resolutionCutRate:          Number(config.resolutionCutRate),
      creatorRoyaltyRate:         Number(config.creatorRoyaltyRate),
      creatorRoyaltyThresholdKes: Number(config.creatorRoyaltyThresholdKes),
      creatorProgrammeActive:     config.creatorProgrammeActive,
      suggestionRewardKes:        Number(config.suggestionRewardKes),
      bountyMinPayoutKes:         Number(config.bountyMinPayoutKes),
      updatedAt:                  config.updatedAt,
      updatedByAdminId:           config.updatedByAdminId,
    },
  });
});
