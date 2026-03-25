// src/app/api/admin/config/carousel/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';
import { z } from 'zod';

const SlideSchema = z.object({
  id:        z.string().optional(),
  tag:       z.string().max(50).optional(),
  title:     z.string().min(1).max(120),
  subtitle:  z.string().max(200).optional(),
  imageUrl:  z.string().url().optional().or(z.literal('')),
  bgColour:  z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#1a1035'),
  ctaText:   z.string().max(50).optional(),
  ctaLink:   z.string().max(500).optional(),
  active:    z.boolean().default(true),
  expiresAt: z.string().datetime().optional().nullable(),
  sortOrder: z.number().int().default(0),
});

const UpsertSchema = z.object({
  slides: z.array(SlideSchema).max(5),
});

// GET — return all slides (including inactive) for admin view
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const slides = await prisma.carouselSlide.findMany({
    orderBy: { sortOrder: 'asc' },
  });
  return NextResponse.json({ slides });
}

// POST — upsert all slides (replaces the full set)
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const body   = await req.json();
  const parsed = UpsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Delete all existing slides and re-create (simple for ≤5 slides)
  await prisma.$transaction(async (tx) => {
    await tx.carouselSlide.deleteMany();
    await tx.carouselSlide.createMany({
      data: parsed.data.slides.map((s, i) => ({
        tag:       s.tag,
        title:     s.title,
        subtitle:  s.subtitle,
        imageUrl:  s.imageUrl || null,
        bgColour:  s.bgColour,
        ctaText:   s.ctaText,
        ctaLink:   s.ctaLink,
        active:    s.active,
        expiresAt: s.expiresAt ? new Date(s.expiresAt) : null,
        sortOrder: s.sortOrder ?? i,
      })),
    });
  });

  const saved = await prisma.carouselSlide.findMany({ orderBy: { sortOrder: 'asc' } });
  return NextResponse.json({ slides: saved });
}
