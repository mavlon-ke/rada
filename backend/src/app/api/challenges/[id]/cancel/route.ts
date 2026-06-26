// src/app/api/challenges/[id]/cancel/route.ts
// Handles challenge cancellation at all lifecycle stages.
//
// PENDING_JOIN — either party:
//   5% fee on Challenger A's stake only (B hasn't staked).
//   A refunded 95%. Challenge → CANCELLED.
//
// ACTIVE — initiate (no body):
//   Sets cancelRequestedBy. Notifies other party to accept or refuse.
//   If other party already requested → auto-executes mutual cancel at 5%.
//
// ACTIVE — accept (body: { agree: true }):
//   5% of total pool. Each gets proportional refund. Challenge → CANCELLED.
//
// ACTIVE — refuse (body: { agree: false }):
//   Challenge → DISPUTED. cancelRequestedBy cleared. Admin alerted. 15% applies.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { createNotification } from '@/lib/notifications';
import { displayName } from '@/lib/user/display-name';
import { sendAdminAlert } from '@/lib/whatsapp/admin-alerts';

const FEE_CANCEL = 0.05;

const Schema = z.object({
  agree: z.boolean().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json().catch(() => ({}));
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { agree } = parsed.data;

  const challenge = await prisma.marketChallenge.findUnique({
    where:   { id: params.id },
    include: { userA: true, userB: true },
  });

  if (!challenge) return NextResponse.json({ error: 'Challenge not found' }, { status: 404 });
  if (challenge.status === 'CANCELLED') {
    return NextResponse.json({ error: 'Challenge already cancelled' }, { status: 400 });
  }
  if (challenge.status === 'RESOLVED') {
    return NextResponse.json({ error: 'Cannot cancel a resolved challenge' }, { status: 400 });
  }

  const isA = challenge.userAId === user.id;
  const isB = challenge.userBId === user.id;
  if (!isA && !isB) {
    return NextResponse.json({ error: 'You are not a participant in this challenge' }, { status: 403 });
  }

  // ── PENDING_JOIN: immediate cancel regardless of initiator ──────────────────
  if (challenge.status === 'PENDING_JOIN') {
    return cancelPendingJoin(challenge, user.id, isA);
  }

  // ── ACTIVE / PENDING_RESOLUTION ─────────────────────────────────────────────
  if (!['ACTIVE', 'PENDING_RESOLUTION'].includes(challenge.status)) {
    return NextResponse.json({
      error: 'Challenge cannot be cancelled in its current state',
    }, { status: 400 });
  }

  if (agree === false) return refuseCancel(challenge, user.id);
  if (agree === true)  return acceptCancel(challenge, user.id);
  return initiateCancel(challenge, user.id, isA);
}

// ── PENDING_JOIN: 5% fee on A's stake ──────────────────────────────────────────
async function cancelPendingJoin(challenge: any, requesterId: string, isA: boolean) {
  const stake  = Number(challenge.stakePerPerson);
  const fee    = Math.floor(stake * FEE_CANCEL);
  const refund = stake - fee;

  await prisma.$transaction(async (tx: any) => {
    if (challenge.userAId) {
      const upd = await tx.user.update({
        where: { id: challenge.userAId },
        data:  { balanceKes: { increment: refund } },
      });
      await tx.transaction.create({
        data: {
          userId:      challenge.userAId,
          challengeId: challenge.id,
          type:        'REFUND',
          amountKes:   refund,
          balAfter:    Number(upd.balanceKes),
          status:      'SUCCESS',
          description: 'Challenge cancelled — KES ' + refund + ' refunded (5% fee: KES ' + fee + ')',
        },
      });
    }
    await tx.marketChallenge.update({
      where: { id: challenge.id },
      data:  { status: 'CANCELLED', cancelRequestedBy: requesterId },
    });
  });

  if (fee > 0) {
    await prisma.platformRevenue.create({
      data: {
        challengeId: challenge.id,
        type:        'CHALLENGE_FEE',
        amountKes:   fee,
        description: 'Cancellation fee (5%) — ' + (isA ? 'cancelled by creator' : 'declined by opponent'),
      },
    });
  }

  // Notify A when B declines
  if (!isA && challenge.userAId && challenge.userB) {
    void createNotification({
      userId:  challenge.userAId,
      type:    'CHALLENGE_RESOLUTION_WARNING',
      title:   '❌ Challenge declined',
      message: displayName(challenge.userB.name, challenge.userB.phone) + ' declined your challenge. KES ' + refund.toLocaleString() + ' refunded. KES ' + fee + ' processing fee applied.',
      link:    '/rada-friends.html',
      whatsapp: {
        template:   'CHALLENGE_RESOLUTION_WARNING',
        parameters: [challenge.question.slice(0, 50)],
      },
    });
  }

  // Notify B when A cancels
  if (isA && challenge.userBId && challenge.userA) {
    void createNotification({
      userId:  challenge.userBId,
      type:    'CHALLENGE_RESOLUTION_WARNING',
      title:   '❌ Challenge cancelled',
      message: displayName(challenge.userA.name, challenge.userA.phone) + ' cancelled the challenge before you could join.',
      link:    '/rada-friends.html',
    });
  }

  return NextResponse.json({
    success: true,
    status:  'CANCELLED',
    refund,
    fee,
    message: 'Challenge cancelled. KES ' + refund.toLocaleString() + ' refunded. KES ' + fee + ' fee applied.',
  });
}

// ── ACTIVE: initiate cancel request ────────────────────────────────────────────
async function initiateCancel(challenge: any, requesterId: string, isA: boolean) {
  const otherId   = isA ? challenge.userBId  : challenge.userAId;
  const other     = isA ? challenge.userB    : challenge.userA;
  const me        = isA ? challenge.userA    : challenge.userB;

  // If other party already requested → both want to cancel → auto-execute
  if (challenge.cancelRequestedBy && challenge.cancelRequestedBy !== requesterId) {
    return executeMutualCancel(challenge, 'mutual request');
  }

  // Idempotent — already requested by me
  if (challenge.cancelRequestedBy === requesterId) {
    return NextResponse.json({ success: true, message: 'Cancel already requested. Waiting for other party.' });
  }

  await prisma.marketChallenge.update({
    where: { id: challenge.id },
    data:  { cancelRequestedBy: requesterId },
  });

  if (otherId && other) {
    void createNotification({
      userId:  otherId,
      type:    'CHALLENGE_RESOLUTION_WINDOW',
      title:   '⚠️ Cancel requested',
      message: displayName(me?.name ?? null, me?.phone ?? '') + ' wants to cancel "' + challenge.question.slice(0, 60) + '". Accept at 5% fee or refuse (admin at 15%).',
      link:    '/rada-friends.html',
      whatsapp: {
        template:   'CHALLENGE_RESOLUTION_WINDOW',
        parameters: [challenge.question.slice(0, 50)],
      },
    });
  }

  return NextResponse.json({ success: true, message: 'Cancel request sent. Waiting for other party.' });
}

// ── ACTIVE: accept cancel ───────────────────────────────────────────────────────
async function acceptCancel(challenge: any, acceptorId: string) {
  if (!challenge.cancelRequestedBy) {
    return NextResponse.json({ error: 'No cancel request to accept' }, { status: 400 });
  }
  if (challenge.cancelRequestedBy === acceptorId) {
    return NextResponse.json({ error: "You cannot accept your own cancel request" }, { status: 400 });
  }
  return executeMutualCancel(challenge, 'mutual agreement');
}

// ── ACTIVE: refuse cancel → DISPUTED ───────────────────────────────────────────
async function refuseCancel(challenge: any, refuserId: string) {
  if (!challenge.cancelRequestedBy) {
    return NextResponse.json({ error: 'No cancel request to refuse' }, { status: 400 });
  }
  if (challenge.cancelRequestedBy === refuserId) {
    return NextResponse.json({ error: "You cannot refuse your own cancel request" }, { status: 400 });
  }

  await prisma.marketChallenge.update({
    where: { id: challenge.id },
    data:  { status: 'DISPUTED', cancelRequestedBy: null },
  });

  const msg = 'The cancel request for "' + challenge.question.slice(0, 50) + '" was refused. Admin will intervene. 15% fee applies at resolution.';

  if (challenge.userAId) {
    void createNotification({
      userId:  challenge.userAId,
      type:    'CHALLENGE_RESOLUTION_WARNING',
      title:   '⚠️ Cancel refused — Admin notified',
      message: msg,
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
      title:   '⚠️ Cancel refused — Admin notified',
      message: msg,
      link:    '/rada-friends.html',
      whatsapp: {
        template:   'CHALLENGE_RESOLUTION_WARNING',
        parameters: [challenge.question.slice(0, 50)],
      },
    });
  }

  void sendAdminAlert('ADMIN_DISPUTE', [
    { name: 'user_one', value: challenge.userA?.name ?? challenge.userA?.phone ?? 'User A' },
    { name: 'user_two', value: challenge.userB?.name ?? challenge.userB?.phone ?? 'User B' },
  ]);

  return NextResponse.json({
    success: true,
    status:  'DISPUTED',
    message: 'Cancel refused. Admin notified. 15% fee applies at resolution.',
  });
}

// ── Shared: execute mutual cancellation at 5% ───────────────────────────────────
async function executeMutualCancel(challenge: any, reason: string) {
  const pool  = Number(challenge.totalPool);
  const fee   = Math.floor(pool * FEE_CANCEL);
  const net   = pool - fee;
  const aGets = Math.floor(net / 2);
  const bGets = net - aGets;

  await prisma.$transaction(async (tx: any) => {
    await tx.marketChallenge.update({
      where: { id: challenge.id },
      data:  { status: 'CANCELLED', cancelRequestedBy: null, resolvedAt: new Date() },
    });

    if (challenge.userAId && aGets > 0) {
      const updA = await tx.user.update({
        where: { id: challenge.userAId },
        data:  { balanceKes: { increment: aGets } },
      });
      await tx.transaction.create({
        data: {
          userId:      challenge.userAId,
          challengeId: challenge.id,
          type:        'REFUND',
          amountKes:   aGets,
          balAfter:    Number(updA.balanceKes),
          status:      'SUCCESS',
          description: 'Challenge cancelled (' + reason + ') — KES ' + aGets + ' refunded',
        },
      });
    }

    if (challenge.userBId && bGets > 0) {
      const updB = await tx.user.update({
        where: { id: challenge.userBId },
        data:  { balanceKes: { increment: bGets } },
      });
      await tx.transaction.create({
        data: {
          userId:      challenge.userBId,
          challengeId: challenge.id,
          type:        'REFUND',
          amountKes:   bGets,
          balAfter:    Number(updB.balanceKes),
          status:      'SUCCESS',
          description: 'Challenge cancelled (' + reason + ') — KES ' + bGets + ' refunded',
        },
      });
    }
  });

  if (fee > 0) {
    await prisma.platformRevenue.create({
      data: {
        challengeId: challenge.id,
        type:        'CHALLENGE_FEE',
        amountKes:   fee,
        description: 'Mutual cancellation fee (5%) — ' + reason,
      },
    });
  }

  const notifMsg = 'Challenge cancelled by ' + reason + '. KES ' + aGets.toLocaleString() + ' refunded to each party. 5% fee (KES ' + fee + ') applied.';

  if (challenge.userAId) {
    void createNotification({
      userId:  challenge.userAId,
      type:    'CHALLENGE_RESOLUTION_WARNING',
      title:   '✅ Challenge cancelled',
      message: notifMsg,
      link:    '/rada-friends.html',
    });
  }
  if (challenge.userBId) {
    void createNotification({
      userId:  challenge.userBId,
      type:    'CHALLENGE_RESOLUTION_WARNING',
      title:   '✅ Challenge cancelled',
      message: notifMsg,
      link:    '/rada-friends.html',
    });
  }

  console.log('[Challenge Cancel] Mutual cancel. Pool: KES ' + pool + ', fee: KES ' + fee + ', A: KES ' + aGets + ', B: KES ' + bGets);

  return NextResponse.json({
    success: true,
    status:  'CANCELLED',
    fee,
    aGets,
    bGets,
    message: 'Challenge cancelled. KES ' + aGets.toLocaleString() + ' refunded to each party.',
  });
}
