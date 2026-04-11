// src/app/api/markets/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { generateUniqueSlug, buildMarketShareUrl } from '@/lib/market/slug';

// ─── GET /api/markets ─────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const category    = searchParams.get('category');
  const status      = searchParams.get('status') ?? 'OPEN';
  const page        = parseInt(searchParams.get('page') ?? '1');
  const limit       = 20;
  const includeSocial = searchParams.get('includeSocial') !== 'false'; // default true

  // ── Auto-close expired markets (no cron needed) ───────────────────────────
  try {
    await prisma.market.updateMany({
      where: { status: 'OPEN', closesAt: { lte: new Date() } },
      data:  { status: 'CLOSED' },
    });
  } catch { /* non-fatal */ }

  // ── Fetch regular markets ────────────────────────────────────────────────
  const markets = await prisma.market.findMany({
    where: {
      status: status as any,
      ...(category ? { category: category as any } : {}),
    },
    include: {
      creator: { select: { phone: true, name: true } },
      _count:  { select: { orders: true } },
    },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
  });

  const enriched = markets.map((m) => {
    const yesPool  = Number(m.yesPool);
    const noPool   = Number(m.noPool);
    const expYes   = Math.exp(yesPool / 1000);
    const expNo    = Math.exp(noPool  / 1000);
    const yesPrice = expYes / (expYes + expNo);

    return {
      ...m,
      yesPrice:        parseFloat(yesPrice.toFixed(4)),
      noPrice:         parseFloat((1 - yesPrice).toFixed(4)),
      tradeCount:      m._count.orders,
      shareUrl:        buildMarketShareUrl(m.slug, null),
      creatorShareUrl: buildMarketShareUrl(m.slug, m.creator?.phone ?? null),
      isSocialChallenge: false,
    };
  });

  // ── Append public Social Challenges under GENERAL ────────────────────────
  // Only fetched when category is GENERAL or unfiltered, and includeSocial is true
  let socialChallenges: any[] = [];
  const fetchSocial = includeSocial && (!category || category === 'GENERAL');

  if (fetchSocial) {
    const publicChallenges = await prisma.marketChallenge.findMany({
      where: {
        isPublic: true,
        status:   { in: ['ACTIVE', 'PENDING_JOIN'] },
      },
      include: {
        userA: { select: { name: true } },
        userB: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    socialChallenges = publicChallenges.map(ch => ({
      id:               ch.id,
      slug:             `social-${ch.accessCode.toLowerCase()}`,
      title:            ch.question,
      category:         'GENERAL',
      status:           'OPEN',
      yesPrice:         0.5,
      noPrice:          0.5,
      tradeCount:       2, // 2 participants
      isSocialChallenge: true,
      accessCode:       ch.accessCode,
      stakePerPerson:   Number(ch.stakePerPerson),
      totalPool:        Number(ch.totalPool),
      participantA:     ch.userA?.name ?? 'Challenger A',
      participantB:     ch.userB?.name ?? 'Challenger B',
      closesAt:         ch.eventExpiresAt,
      shareUrl:         `${process.env.NEXT_PUBLIC_BASE_URL}/join/${ch.accessCode}`,
    }));
  }

  return NextResponse.json({
    markets: [...enriched, ...socialChallenges],
    page,
    limit,
  });
}

// ─── POST /api/markets ────────────────────────────────────────────────────────

const CreateMarketSchema = z.object({
  title:       z.string().min(10).max(200),
  description: z.string().min(20).max(2000),
  category:    z.enum(['GENERAL','POLITICS','ECONOMY','ENTERTAINMENT','WEATHER','TECH','FRIENDS']),
  closesAt:    z.string().datetime(),
  imageUrl:    z.string().url().optional(),
  sourceNote:  z.string().max(300).optional(),
});

export async function POST(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json();
  const parsed = CreateMarketSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { title, description, category, closesAt, imageUrl, sourceNote } = parsed.data;

  if (new Date(closesAt) <= new Date()) {
    return NextResponse.json({ error: 'closesAt must be in the future' }, { status: 400 });
  }

  // Auto-generate unique slug from title
  const slug = await generateUniqueSlug(title);

  const market = await prisma.market.create({
    data: {
      slug,
      title,
      description,
      category,
      closesAt:   new Date(closesAt),
      imageUrl,
      sourceNote,
      creatorId:  user.id,
      yesPool:    1000,
      noPool:     1000,
    },
    include: { creator: { select: { phone: true } } },
  });

  return NextResponse.json({
    market,
    shareUrl:        buildMarketShareUrl(slug, null),
    creatorShareUrl: buildMarketShareUrl(slug, market.creator.phone),
  }, { status: 201 });
}
