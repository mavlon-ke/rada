// src/app/api/users/me/referee-queue/route.ts
// Returns challenges where the current user is nominated as referee
// Includes accept/decline actions

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { createNotification } from '@/lib/notifications';


export async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const queue = await prisma.marketChallenge.findMany({
    where: { refereeId: user.id },
    include: {
      userA: { select: { name: true, phone: true, integrityScore: true } },
      userB: { select: { name: true, phone: true, integrityScore: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ queue });
}

// POST /api/users/me/referee-queue  body: { challengeId, action: 'ACCEPT' | 'DECLINE' }
export async function POST(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { challengeId, action } = await req.json();
  if (!challengeId || !['ACCEPT', 'DECLINE'].includes(action)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const challenge = await prisma.marketChallenge.findUnique({
    where: { id: challengeId },
    include: { userA: true },
  });

  if (!challenge)                      return NextResponse.json({ error: 'Challenge not found' }, { status: 404 });
  if (challenge.refereeId !== user.id) return NextResponse.json({ error: 'You are not the referee for this challenge' }, { status: 403 });
  if (challenge.refereeAccepted)       return NextResponse.json({ error: 'You have already accepted this referee request' }, { status: 400 });

  if (action === 'ACCEPT') {
    await prisma.marketChallenge.update({
      where: { id: challengeId },
      data:  { refereeAccepted: true, validatorType: 'REFEREE' },
    });
    await createNotification({
      userId:  challenge.userAId,
      type:    'REFEREE_NOMINATED',
      title:   '✅ Referee accepted',
      message: `Your referee accepted the nomination for "${challenge.question.slice(0, 50)}...". They will resolve after the event.`,
      link:    `/rada-friends.html`,
    });
    return NextResponse.json({ success: true, action: 'ACCEPTED' });
  }

  // DECLINE — remove referee, fall back to mutual consent
  await prisma.marketChallenge.update({
    where: { id: challengeId },
    data:  { refereeId: null, refereeAccepted: false, validatorType: 'MUTUAL' },
  });
  await createNotification({
    userId:  challenge.userAId,
    type:    'REFEREE_NOMINATED',
    title:   '❌ Referee declined',
    message: `Your referee declined the nomination for "${challenge.question.slice(0, 50)}...". The challenge will use mutual consent instead.`,
    link:    `/rada-friends.html`,
  });
  return NextResponse.json({ success: true, action: 'DECLINED' });
}
