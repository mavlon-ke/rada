// src/app/api/config/referral/route.ts
// Public endpoint — returns referral programme config for frontend display.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

export async function GET() {
  let config = await prisma.referralConfig.findUnique({ where: { id: 'singleton' } });

  // Create default config if it doesn't exist
  if (!config) {
    config = await prisma.referralConfig.create({
      data: { id: 'singleton' },
    });
  }

  return NextResponse.json({ config });
}
