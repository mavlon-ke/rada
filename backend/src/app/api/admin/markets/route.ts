// src/app/api/admin/markets/route.ts
// Admin-authenticated market management
// GET  /api/admin/markets — list all markets (all statuses) for admin table
// POST /api/admin/markets — create a new market as admin

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';
import { generateUniqueSlug, buildMarketShareUrl } from '@/lib/market/slug';

// ─── GET /api/admin/markets ───────────────────────────────────────────────────
// Returns all markets across all statuses for the admin panel table.
// Supports ?status=OPEN|CLOSED|RESOLVED|CANCELLED and ?category= filters.

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  // ── Auto-close expired markets ────────────────────────────────────────────
  try {
    await prisma.market.updateMany({
      where: { status: 'OPEN', closesAt: { lte: new Date() } },
      data:  { status: 'CLOSED' },
    });
  } catch { /* non-fatal */ }

  const { searchParams } = new URL(req.url);
  const status   = searchParams.get('status');   // optional filter
  const category = searchParams.get('category'); // optional filter
  const page     = parseInt(searchParams.get('page') ?? '1');
  const limit    = 50;

  const markets = await prisma.market.findMany({
    where: {
      ...(status   ? { status:   status   as any } : {}),
      ...(category ? { category: category as any } : {}),
    },
    include: {
      creator: { select: { phone: true, name: true } },
      _count:  { select: { orders: true, positions: true } },
    },
    orderBy: { createdAt: 'desc' },
    skip:  (page - 1) * limit,
    take:  limit,
  });

  const enriched = markets.map((m) => {
    const yesPool  = Number(m.yesPool);
    const noPool   = Number(m.noPool);
    const expYes   = Math.exp(yesPool / 1000);
    const expNo    = Math.exp(noPool  / 1000);
    const yesPrice = expYes / (expYes + expNo);

    return {
      id:           m.id,
      slug:         m.slug,
      title:        m.title,
      description:  m.description,
      category:     m.category,
      status:       m.status,
      outcome:      m.outcome,
      yesPool,
      noPool,
      yesPrice:     parseFloat(yesPrice.toFixed(4)),
      noPrice:      parseFloat((1 - yesPrice).toFixed(4)),
      totalVolume:  Number(m.totalVolume),
      tradeCount:   m._count.orders,
      positionCount: m._count.positions,
      closesAt:     m.closesAt,
      resolvedAt:   m.resolvedAt,
      createdAt:    m.createdAt,
      creator:      m.creator,
      sourceNote:   m.sourceNote,
      imageUrl:     m.imageUrl,
    };
  });

  const total = await prisma.market.count({
    where: {
      ...(status   ? { status:   status   as any } : {}),
      ...(category ? { category: category as any } : {}),
    },
  });

  return NextResponse.json({ markets: enriched, page, limit, total });
}

// ─── POST /api/admin/markets ──────────────────────────────────────────────────
// Admin creates a market. Uses admin JWT — does NOT require a user account.
// The market creator is set to the platform's system user (first admin-seeded user).

const CreateMarketSchema = z.object({
  title:       z.string().min(10).max(200),
  description: z.string().min(20).max(2000),
  category:    z.enum(['GENERAL', 'POLITICS', 'ECONOMY', 'ENTERTAINMENT', 'WEATHER', 'TECH', 'FRIENDS']),
  closesAt:    z.string().datetime(),
  sourceNote:  z.string().max(300).optional(),
  imageUrl:    z.string().url().optional(),
});

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const body   = await req.json();
  const parsed = CreateMarketSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { title, description, category, closesAt, sourceNote, imageUrl } = parsed.data;

  if (new Date(closesAt) <= new Date()) {
    return NextResponse.json({ error: 'closesAt must be in the future' }, { status: 400 });
  }

  // Use the platform's first seeded user as creator for admin-created markets
  const systemUser = await prisma.user.findFirst({
    orderBy: { createdAt: 'asc' },
  });

  if (!systemUser) {
    return NextResponse.json(
      { error: 'No platform user found. Run db:seed first.' },
      { status: 500 }
    );
  }

  const slug = await generateUniqueSlug(title);

  const market = await prisma.market.create({
    data: {
      slug,
      title,
      description,
      category,
      closesAt:  new Date(closesAt),
      sourceNote,
      imageUrl,
      creatorId: systemUser.id,
      yesPool:   1000,
      noPool:    1000,
    },
  });

  await logAdminAction(
    admin.id,
    'MARKET_CREATED',
    market.id,
    { title: market.title, category, slug },
    req
  );

  return NextResponse.json({
    success: true,
    market: {
      ...market,
      yesPool:  Number(market.yesPool),
      noPool:   Number(market.noPool),
      shareUrl: buildMarketShareUrl(slug, null),
    },
  }, { status: 201 });
}
