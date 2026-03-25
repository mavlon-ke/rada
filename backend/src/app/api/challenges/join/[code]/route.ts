// src/app/api/challenges/join/[code]/route.ts
// GET  — look up a challenge by access code (preview before staking)
// POST — join the challenge and stake your amount

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';


export async function GET(
  _req: NextRequest,
  { params }: { params: { code: string } }
) {
  const challenge = await prisma.marketChallenge.findUnique({
    where: { accessCode: params.code.toUpperCase() },
    include: {
      userA:   { select: { name: true } },
      referee: { select: { name: true } },
    },
  });

  if (!challenge) return NextResponse.json({ error: 'Challenge not found' }, { status: 404 });
  if (challenge.status !== 'PENDING_JOIN') {
    return NextResponse.json({ error: 'This challenge is no longer open to join' }, { status: 400 });
  }

  return NextResponse.json({
    challengeId:    challenge.id,
    question:       challenge.question,
    stakePerPerson: challenge.stakePerPerson,
    eventExpiresAt: challenge.eventExpiresAt,
    validatorType:  challenge.validatorType,
    createdBy:      challenge.userA.name ?? 'Anonymous',
    hasReferee:     !!challenge.refereeId,
    refereeName:    challenge.referee?.name ?? null,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { code: string } }
) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const challenge = await prisma.marketChallenge.findUnique({
    where: { accessCode: params.code.toUpperCase() },
    include: { userA: { select: { phone: true, name: true } } },
  });

  if (!challenge)                          return NextResponse.json({ error: 'Challenge not found' }, { status: 404 });
  if (challenge.status !== 'PENDING_JOIN') return NextResponse.json({ error: 'Challenge already has two participants' }, { status: 400 });
  if (challenge.userAId === user.id)       return NextResponse.json({ error: 'You created this challenge' }, { status: 400 });

  const stake = Number(challenge.stakePerPerson);
  if (Number(user.balanceKes) < stake) {
    return NextResponse.json({ error: `Insufficient balance. You need KES ${stake} to join.` }, { status: 400 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const freshUser = await tx.user.findUnique({ where: { id: user.id } });
    if (!freshUser || Number(freshUser.balanceKes) < stake) throw new Error('Insufficient balance');

    await tx.user.update({
      where: { id: user.id },
      data:  { balanceKes: { decrement: stake } },
    });

    const ch = await tx.marketChallenge.update({
      where: { id: challenge.id },
      data: {
        userBId:   user.id,
        totalPool: { increment: stake },
        status:    'ACTIVE',
      },
    });

    const newBal = Number(freshUser.balanceKes) - stake;
    await tx.transaction.create({
      data: {
        userId:      user.id,
        challengeId: ch.id,
        type:        'CHALLENGE_STAKE',
        amountKes:   -stake,
        balAfter:    newBal,
        status:      'SUCCESS',
        description: `Joined challenge: "${challenge.question.slice(0, 60)}"`,
      },
    });

    return ch;
  });

  // Notify creator
  await console.log(challenge.userA.phone,
    `Rada: ${user.name ?? 'Someone'} accepted your challenge! ` +
    `"${challenge.question.slice(0, 50)}..." is now ACTIVE. Pool: KES ${Number(updated.totalPool)}.`
  );

  return NextResponse.json({ success: true, challengeId: challenge.id, status: 'ACTIVE' });
}
