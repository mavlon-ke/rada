import { sanitizeText } from '@/lib/security/middleware';
// src/app/api/markets/propose/route.ts
// Users submit market ideas — approved ones earn the configured suggestion reward (PlatformConfig)

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { sendAdminAlert } from '@/lib/whatsapp/admin-alerts';

const Schema = z.object({
  question:         z.string().min(10).max(200),
  category:         z.enum(['GENERAL','POLITICS','ECONOMY','ENTERTAINMENT','WEATHER','TECH']),
  resolutionSource: z.string().min(5).max(300),
  whyCareNote:      z.string().max(5000).optional(),
  // Suggested resolution date — admin can override during approval.
  // Accepts ISO 8601 datetime strings or YYYY-MM-DD date strings; either way Prisma stores as DateTime.
  closesAt:         z.string().datetime().optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
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

  // Parse closesAt: accept either YYYY-MM-DD (treat as midnight UTC end-of-day) or full ISO datetime.
  // Reject dates in the past — must be at least tomorrow.
  let closesAt: Date | undefined = undefined;
  if (parsed.data.closesAt) {
    const raw = parsed.data.closesAt;
    // YYYY-MM-DD → end of day in UTC. ISO datetime → as-is.
    closesAt = raw.length === 10 ? new Date(raw + 'T23:59:59.000Z') : new Date(raw);
    if (isNaN(closesAt.getTime())) {
      return NextResponse.json({ error: 'Invalid resolution date' }, { status: 400 });
    }
    if (closesAt.getTime() < Date.now()) {
      return NextResponse.json({ error: 'Resolution date must be in the future' }, { status: 400 });
    }
  }

  const proposal = await prisma.marketProposal.create({
    data: {
      proposerId:       user.id,
      question:         sanitizeText(parsed.data.question),
      category:         parsed.data.category,
      resolutionSource: sanitizeText(parsed.data.resolutionSource),
      whyCareNote:      parsed.data.whyCareNote ? sanitizeText(parsed.data.whyCareNote) : undefined,
      closesAt,
    },
  });

  // Fire admin alert — fire-and-forget, never blocks the response
  void sendAdminAlert('ADMIN_PROPOSAL', [
    { name: 'proposer_name', value: user.name ?? user.phone ?? 'A user' },
  ]);

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
