// backend/src/app/api/markets/by-slug/[slug]/route.ts
//
// Public, unauthenticated endpoint — called by the Cloudflare Worker that
// intercepts checkrada.co.ke/m/{slug} to build the social-preview /
// SEO landing page. Deliberately returns only the small subset of fields
// safe to show pre-login: no creatorId, no pool/volume figures, nothing
// that could be considered sensitive or that changes the trust model.
//
// Verified against the real Market schema before writing this:
// title (String, required), imageUrl (String?, nullable), slug (unique).
//
// Matches the exact pattern already established in
// api/config/public/route.ts: withErrorHandling wrapper + short edge
// cache, since this data rarely changes and will be hit repeatedly
// whenever a market's link gets shared.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { withErrorHandling } from '@/lib/security/route-guard';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async function GET(
  req: NextRequest,
  context: { params: { slug: string } }
) {
  const { slug } = context.params;
  if (!slug) {
    return NextResponse.json({ error: 'Missing slug' }, { status: 400 });
  }

  const market = await prisma.market.findUnique({
    where: { slug },
    select: {
      title:    true,
      imageUrl: true,
      category: true,
      status:   true,
      closesAt: true,
    },
  });

  if (!market) {
    return NextResponse.json({ error: 'Market not found' }, { status: 404 });
  }

  return NextResponse.json(market, {
    headers: {
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
    },
  });
});
