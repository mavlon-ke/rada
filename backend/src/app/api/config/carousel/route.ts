// src/app/api/config/carousel/route.ts
// Public endpoint — returns active, non-expired carousel slides for the frontend.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
export const dynamic = 'force-dynamic';
export async function GET() {
  const now = new Date();

  const slides = await prisma.carouselSlide.findMany({
    where: {
      active: true,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
    },
    orderBy: { sortOrder: 'asc' },
    take: 5,
  });

  return NextResponse.json({ slides });
}
