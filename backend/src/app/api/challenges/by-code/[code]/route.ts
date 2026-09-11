// backend/src/app/api/challenges/by-code/[code]/route.ts
//
// Public, unauthenticated endpoint — called by the Cloudflare Worker that
// intercepts checkrada.co.ke/join/{code} to build the social-preview /
// SEO landing page. Deliberately returns only what's safe to show
// pre-login: no userAId/userBId, no financial pool totals, nothing that
// identifies who the participants are beyond what they've chosen to make
// public by sharing the link in the first place.
//
// Verified against the real MarketChallenge schema before writing this:
// question (String, required), stakePerPerson (Decimal), no imageUrl
// field exists on this model at all — confirmed directly, not assumed.
//
// Same withErrorHandling + short edge-cache pattern as the market
// lookup, for consistency with the rest of the codebase.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { withErrorHandling } from '@/lib/security/route-guard';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async function GET(
  req: NextRequest,
  context: { params: { code: string } }
) {
  const { code } = context.params;
  if (!code) {
    return NextResponse.json({ error: 'Missing code' }, { status: 400 });
  }

  const challenge = await prisma.marketChallenge.findUnique({
    where: { accessCode: code },
    select: {
      question:       true,
      stakePerPerson: true,
      status:         true,
      eventExpiresAt: true,
    },
  });

  if (!challenge) {
    return NextResponse.json({ error: 'Challenge not found' }, { status: 404 });
  }

  return NextResponse.json({
    question:       challenge.question,
    stakePerPerson: Number(challenge.stakePerPerson),
    status:         challenge.status,
    eventExpiresAt: challenge.eventExpiresAt,
  }, {
    headers: {
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
    },
  });
});
