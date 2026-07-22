// src/app/api/challenges/[id]/referee/route.ts
// Referee accept or decline nomination.
//
// ACCEPT: Sends notification to both challengers that referee has acknowledged the role.
//         No DB change required — referee remains in the queue.
//
// DECLINE: Changes validatorType → MUTUAL, clears refereeId.
//          Notifies both challengers with consequences (5% mutual / 15% admin).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma }             from '@/lib/db/prisma';
import { requireAuth }        from '@/lib/auth/session';
import { createNotification } from '@/lib/notifications';
import { displayName }        from '@/lib/user/display-name';
import { withErrorHandling } from '@/lib/security/route-guard';

const Schema = z.object({
  action: z.enum(['ACCEPT', 'DECLINE']),
});

export const POST = withErrorHandling(async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json().catch(() => ({}));
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const challenge = await prisma.marketChallenge.findUnique({
    where:   { id: params.id },
    include: { userA: true, userB: true, referee: true },
  });

  if (!challenge) return NextResponse.json({ error: 'Challenge not found' }, { status: 404 });
  if (challenge.refereeId !== user.id) {
    return NextResponse.json({ error: 'You are not the referee for this challenge' }, { status: 403 });
  }
  if (!['PENDING_JOIN', 'ACTIVE', 'PENDING_RESOLUTION'].includes(challenge.status)) {
    return NextResponse.json({ error: 'Challenge is not in a state that requires referee action' }, { status: 400 });
  }

  const refName = displayName(user.name, user.phone);
  const aName   = challenge.userA ? displayName(challenge.userA.name, challenge.userA.phone) : 'Challenger A';
  const bName   = challenge.userB ? displayName(challenge.userB.name, challenge.userB.phone) : 'Challenger B';

  // ── ACCEPT ────────────────────────────────────────────────────────────────
  if (parsed.data.action === 'ACCEPT') {
    const msg = `${refName} has accepted the referee role for "${challenge.question.slice(0, 60)}". They will judge the outcome when both parties have staked.`;

    if (challenge.userAId) {
      void createNotification({
        userId:  challenge.userAId,
        type:    'REFEREE_NOMINATED',
        title:   '⚖️ Referee confirmed',
        message: msg,
        link:    '/rada-friends.html',
      });
    }
    if (challenge.userBId) {
      void createNotification({
        userId:  challenge.userBId,
        type:    'REFEREE_NOMINATED',
        title:   '⚖️ Referee confirmed',
        message: msg,
        link:    '/rada-friends.html',
      });
    }

    return NextResponse.json({
      success: true,
      action:  'ACCEPTED',
      message: 'You have accepted the referee role. Both challengers have been notified.',
    });
  }

  // ── DECLINE ───────────────────────────────────────────────────────────────
  await prisma.marketChallenge.update({
    where: { id: challenge.id },
    data:  {
      refereeId:     null,
      validatorType: 'MUTUAL',
    },
  });

  const declineMsg = `${refName} declined the referee role for "${challenge.question.slice(0, 60)}". The challenge will now be resolved by mutual consent (5% fee) or admin intervention (15% fee) if you cannot agree.`;

  if (challenge.userAId) {
    void createNotification({
      userId:  challenge.userAId,
      type:    'CHALLENGE_RESOLUTION_WARNING',
      title:   '⚠️ Referee declined',
      message: declineMsg,
      link:    '/rada-friends.html',
      whatsapp: {
        template:   'CHALLENGE_RESOLUTION_WARNING',
        parameters: [challenge.question.slice(0, 50)],
      },
    });
  }
  if (challenge.userBId) {
    void createNotification({
      userId:  challenge.userBId,
      type:    'CHALLENGE_RESOLUTION_WARNING',
      title:   '⚠️ Referee declined',
      message: declineMsg,
      link:    '/rada-friends.html',
      whatsapp: {
        template:   'CHALLENGE_RESOLUTION_WARNING',
        parameters: [challenge.question.slice(0, 50)],
      },
    });
  }

  return NextResponse.json({
    success: true,
    action:  'DECLINED',
    message: 'You have declined the referee role. The challenge will now use mutual consent resolution. Both challengers have been notified.',
  });
});
