import { sanitizeText } from '@/lib/security/middleware';
// src/app/api/markets/propose/route.ts
// Users submit market ideas — approved ones earn KES 50 wallet reward

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';

const Schema = z.object({
  question:         z.string().min(10).max(200),
  category:         z.enum(['GENERAL','POLITICS','ECONOMY','ENTERTAINMENT','WEATHER','TECH']),
  resolutionSource: z.string().min(5).max(300),
  whyCareNote:      z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json();
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  // Prevent spam — max 3 pending proposals per user
  const pendingCount = await prisma.marketProposal.count({
    where: { proposerId: user.id, status: 'PENDING' },
  });
  if (pendingCount >= 3) {
    return NextResponse.json({ error: 'You have 3 proposals pending review. Wait for them to be processed.' }, { status: 429 });
  }

  const proposal = await prisma.marketProposal.create({
    data: {
      proposerId:       user.id,
      question:         parsed.data.question,
      category:         parsed.data.category,
      resolutionSource: parsed.data.resolutionSource,
      whyCareNote:      parsed.data.whyCareNote,
    },
  });

  return NextResponse.json({ success: true, proposalId: proposal.id });
}

export async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const proposals = await prisma.marketProposal.findMany({
    where:   { proposerId: user.id },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ proposals });
}
