// src/app/api/markets/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { sanitizeText } from '@/lib/security/middleware';
import { generateUniqueSlug, buildMarketShareUrl } from '@/lib/market/slug';
import { maskPhone, displayName }                  from '@/lib/user/display-name';

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

  // ── System user = admin-created markets — suppress creator badge ──────────
  const systemUser = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  const systemUserId = systemUser?.id ?? null;

  // ── Fetch regular markets ────────────────────────────────────────────────
  // Note: `description` is intentionally omitted from the list response.
  // It's not displayed on market cards. The single-market endpoint returns it
  // in full for the detail modal. Keeps response payload small for pagination.
  const where = {
    status: status as any,
    ...(category ? { category: category as any } : {}),
  };

  const [markets, total] = await Promise.all([
    prisma.market.findMany({
      where,
      select: {
        id:           true,
        slug:         true,
        title:        true,
        category:     true,
        status:       true,
        outcome:      true,
        yesPool:      true,
        noPool:       true,
        totalVolume:  true,
        closesAt:     true,
        resolvedAt:   true,
        createdAt:    true,
        imageUrl:     true,
        sourceNote:   true,
        creator: { select: { id: true, phone: true, name: true } },
        _count:  { select: { orders: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.market.count({ where }),
  ]);

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
      // Suppress creator badge for admin-created markets (system user)
      creatorShareUrl: m.creator.id !== systemUserId ? buildMarketShareUrl(m.slug, maskPhone(m.creator.phone)) : buildMarketShareUrl(m.slug, null),
      isAdminMarket:   m.creator.id === systemUserId,
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
        userA: { select: { name: true, phone: true } },
        userB: { select: { name: true, phone: true } },
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
      participantA:     displayName(ch.userA?.name, ch.userA?.phone) ?? 'Challenger A',
      participantB:     displayName(ch.userB?.name, ch.userB?.phone) ?? 'Challenger B',
      closesAt:         ch.eventExpiresAt,
      shareUrl:         `${process.env.NEXT_PUBLIC_BASE_URL}/join/${ch.accessCode}`,
    }));
  }

  // hasMore tells the frontend whether to keep paginating regular markets.
  // Social challenges (when fetched) are appended only on page 1 to avoid duplicates.
  const hasMore = page * limit < total;

  return NextResponse.json({
    markets: page === 1 ? [...enriched, ...socialChallenges] : enriched,
    page,
    limit,
    total,
    hasMore,
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

  // Only ADMIN role may create markets directly.
  // Regular users submit proposals via POST /api/markets/propose (moderated flow).
  const userWithRole = await prisma.user.findUnique({
    where:  { id: user.id },
    select: { role: true },
  });
  if (!userWithRole || userWithRole.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Admin access required to create markets directly. Use the proposal flow instead.' }, { status: 403 });
  }

  const safeTitle       = sanitizeText(parsed.data.title);
  const safeDescription = sanitizeText(parsed.data.description);
  const safeSourceNote  = parsed.data.sourceNote ? sanitizeText(parsed.data.sourceNote) : undefined;
  const { category, closesAt, imageUrl } = parsed.data;

  if (new Date(closesAt) <= new Date()) {
    return NextResponse.json({ error: 'closesAt must be in the future' }, { status: 400 });
  }

  // Auto-generate unique slug from sanitized title
  const slug = await generateUniqueSlug(safeTitle);

  const market = await prisma.market.create({
    data: {
      slug,
      title:       safeTitle,
      description: safeDescription,
      category,
      closesAt:   new Date(closesAt),
      imageUrl,
      sourceNote:  safeSourceNote,
      creatorId:  user.id,
      yesPool:    1000,
      noPool:     1000,
    },
    include: { creator: { select: { phone: true } } },
  });

  return NextResponse.json({
    market,
    shareUrl:        buildMarketShareUrl(slug, null),
    creatorShareUrl: buildMarketShareUrl(slug, maskPhone(market.creator.phone)),
  }, { status: 201 });
}
