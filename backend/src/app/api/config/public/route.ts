// src/app/api/config/public/route.ts
// Public endpoint exposing the small subset of PlatformConfig that's safe
// to show users on landing pages and the creator page (rada-creator.html
// BOUNTY_STATS panel, dashboard suggestion-reward copy, etc).
//
// What's exposed:
//   - creatorRoyaltyRate
//   - creatorRoyaltyThresholdKes
//   - suggestionRewardKes
//   - creatorProgrammeActive
//
// What's NOT exposed (intentionally — backend-only):
//   - hard cap (security through obscurity is no security, but no need to
//     advertise the ceiling either)
//   - bountyMinPayoutKes (admin operational detail, not user-facing)
//   - updatedByAdminId / updatedAt (audit trail, admin only)
//
// Edge-cached with 60s SWR — config rarely changes; no point hitting
// the DB on every page load.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

export async function GET() {
  const config = await prisma.platformConfig.findUnique({
    where: { id: 'singleton' },
  });

  // Defensive defaults match the schema defaults.
  const payload = {
    creatorRoyaltyRate:         config ? Number(config.creatorRoyaltyRate)         : 0.005,
    creatorRoyaltyThresholdKes: config ? Number(config.creatorRoyaltyThresholdKes) : 1000,
    suggestionRewardKes:        config ? Number(config.suggestionRewardKes)        : 50,
    creatorProgrammeActive:     config ? config.creatorProgrammeActive             : true,
  };

  return NextResponse.json(payload, {
    headers: {
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
    },
  });
}
