// src/app/api/markets/[marketId]/route.ts
// Lookup a market by CUID id OR by slug — supports both:
//   GET /api/markets/cm3xfoo123          (by DB id)
//   GET /api/markets/will-ruto-finish    (by slug)
// Also handles ?c=[phone] creator attribution cookie-setting

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { buildMarketShareUrl } from '@/lib/market/slug';

export async function GET(
  req: NextRequest,
  { params }: { params: { marketId: string } }
) {
  const id = params.marketId;

  // Try id first (CUID starts with 'c'), then slug
  const market = await prisma.market.findFirst({
    where: {
      OR: [
        { id },
        { slug: id },
      ],
    },
    include: {
      creator: { select: { phone: true, name: true } },
      _count:  { select: { orders: true } },
    },
  });

  if (!market) return NextResponse.json({ error: 'Market not found' }, { status: 404 });

  const yesPool  = Number(market.yesPool);
  const noPool   = Number(market.noPool);
  const expYes   = Math.exp(yesPool / 1000);
  const expNo    = Math.exp(noPool  / 1000);
  const yesPrice = expYes / (expYes + expNo);

  // Read creator attribution from ?c= param
  const creatorPhone = req.nextUrl.searchParams.get('c');

  const response = NextResponse.json({
    market: {
      ...market,
      yesPrice:        parseFloat(yesPrice.toFixed(4)),
      noPrice:         parseFloat((1 - yesPrice).toFixed(4)),
      tradeCount:      market._count.orders,
      shareUrl:        buildMarketShareUrl(market.slug, null),
      creatorShareUrl: buildMarketShareUrl(market.slug, market.creator.phone),
    },
  });

  // Set attribution cookie (30 days) so trade route can read it
  if (creatorPhone) {
    response.cookies.set(`rada_ref_${market.id}`, creatorPhone, {
      httpOnly: true,
      maxAge:   60 * 60 * 24 * 30,
      path:     '/',
      sameSite: 'lax',
    });
  }

  return response;
}
