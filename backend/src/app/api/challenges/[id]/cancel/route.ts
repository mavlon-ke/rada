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
  // Compute participant roles before any status branching
  const isA = challenge.userAId === user.id;
  const isB = challenge.userBId === user.id;

  if (challenge.status === 'CANCELLED') {
    return NextResponse.json({ error: 'Challenge already cancelled' }, { status: 400 });
  }
  if (challenge.status === 'RESOLVED') {
    return NextResponse.json({ error: 'Cannot cancel a resolved challenge' }, { status: 400 });
  }

  // ── PENDING_PAYMENT: full refund, no fee (challenge was never live) ────────
  if (challenge.status === 'PENDING_PAYMENT') {
    if (!isA) {
      return NextResponse.json({ error: 'Only the challenge creator can cancel a pending payment' }, { status: 403 });
    }
    return cancelPendingPayment(challenge, user.id);
  }

  if (!isA && !isB) {
    return NextResponse.json({ error: 'You are not a participant in this challenge' }, { status: 403 });
  }

  // ── PENDING_BOTH: nobody has staked → free cancel for any participant ───────
  if (challenge.status === 'PENDING_BOTH') {
    if (!isA && !isB && challenge.refereeId !== user.id) {
      return NextResponse.json({ error: 'You are not a participant in this challenge' }, { status: 403 });
    }
    return cancelPendingBoth(challenge, user.id);
  }

  // ── PENDING_B: A has staked, B hasn't → 5% on A's stake ──────────────────
  if (challenge.status === 'PENDING_B') {
    if (!isA && !isB && challenge.refereeId !== user.id) {
      return NextResponse.json({ error: 'You are not a participant in this challenge' }, { status: 403 });
    }
    return cancelHalfStaked(challenge, 'A', user.id);
  }

  // ── PENDING_A: B has staked, A hasn't → 5% on B's stake ──────────────────
  if (challenge.status === 'PENDING_A') {
    if (!isA && !isB && challenge.refereeId !== user.id) {
      return NextResponse.json({ error: 'You are not a participant in this challenge' }, { status: 403 });
    }
    return cancelHalfStaked(challenge, 'B', user.id);
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

// ── PENDING_BOTH: free cancel — nobody has staked ────────────────────────────
async function cancelPendingBoth(challenge: any, requesterId: string) {
  await prisma.marketChallenge.update({
    where: { id: challenge.id },
    data:  { status: 'CANCELLED', cancelRequestedBy: requesterId },
  });

  // Notify all three parties
  const msg = 'The challenge "' + challenge.question.slice(0, 50) + '" was cancelled. No fee — nobody had staked yet.';
  const notifyIds = [challenge.userAId, challenge.userBId, challenge.refereeId].filter(
    (id: string | null): id is string => !!id && id !== requesterId
  );
  for (const uid of notifyIds) {
    void createNotification({
      userId: uid, type: 'CHALLENGE_RESOLUTION_WARNING',
      title: '❌ Challenge cancelled', message: msg, link: '/rada-friends.html',
    });
  }

  return NextResponse.json({ success: true, status: 'CANCELLED', fee: 0,
    message: 'Challenge cancelled. No fee applied — nobody had staked yet.' });
}

// ── PENDING_B (A staked) or PENDING_A (B staked): 5% on the staked party ────
async function cancelHalfStaked(challenge: any, stakedSide: 'A' | 'B', requesterId: string) {
  const stakedUserId = stakedSide === 'A' ? challenge.userAId : challenge.userBId;
  const stake  = Number(challenge.stakePerPerson);
  const fee    = Math.floor(stake * FEE_CANCEL);
  const refund = stake - fee;

  await prisma.$transaction(async (tx: any) => {
    if (stakedUserId && refund > 0) {
      const upd = await tx.user.update({
        where: { id: stakedUserId },
        data:  { balanceKes: { increment: refund } },
      });
      await tx.transaction.create({
        data: {
          userId:      stakedUserId,
          challengeId: challenge.id,
          type:        'REFUND',
          amountKes:   refund,
          balAfter:    Number(upd.balanceKes),
          status:      'SUCCESS',
          description: 'Referee challenge cancelled — KES ' + refund + ' refunded (5% fee: KES ' + fee + ')',
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
        description: 'Cancellation fee (5%) — Challenger ' + stakedSide + ' had staked',
      },
    });
  }

  // Notify all three parties
  const msg = 'Challenge cancelled. Challenger ' + stakedSide + ' refunded KES ' + refund.toLocaleString() + ' (5% fee: KES ' + fee + ').';
  const allIds = [challenge.userAId, challenge.userBId, challenge.refereeId].filter(
    (id: string | null): id is string => !!id
  );
  for (const uid of allIds) {
    void createNotification({
      userId: uid, type: 'CHALLENGE_RESOLUTION_WARNING',
      title: '❌ Challenge cancelled', message: msg, link: '/rada-friends.html',
    });
  }

  return NextResponse.json({ success: true, status: 'CANCELLED', fee, refund,
    message: 'Challenge cancelled. KES ' + refund.toLocaleString() + ' refunded. KES ' + fee + ' fee applied.' });
}

// ── PENDING_PAYMENT: full refund, no fee ─────────────────────────────────────
// Challenge was never live (B never joined, M-Pesa never confirmed).
// Full wallet refund — no 5% fee since the challenge was never accepted.
async function cancelPendingPayment(challenge: any, requesterId: string) {
  // Look up wallet transactions by type BEFORE the transaction block.
  // Two separate records were created at stake time: CHALLENGE_STAKE (real) + BONUS_USED (bonus).
  // This lets us refund each portion to the correct balance bucket.
  const walletTxns = await prisma.transaction.findMany({
    where: {
      challengeId: challenge.id,
      userId:      requesterId,
      status:      'SUCCESS',
      amountKes:   { lt: 0 },
      type:        { in: ['CHALLENGE_STAKE', 'BONUS_USED'] },
    },
  });

  let realRefund  = 0;
  let bonusRefund = 0;
  for (const t of walletTxns) {
    const amt = Math.abs(Number(t.amountKes));
    if (t.type === 'CHALLENGE_STAKE') realRefund  += amt;
    else if (t.type === 'BONUS_USED') bonusRefund += amt;
  }
  const totalRefund = realRefund + bonusRefund;

  // Use atomic updateMany with status guard to prevent double-cancel race condition.
  // If two concurrent requests both pass the outer status check, only the first
  // to commit this UPDATE will match (count === 1). The second gets count === 0
  // and throws, rolling back the entire transaction safely.
  let cancellationSucceeded = false;

  await prisma.$transaction(async (tx: any) => {
    const guard = await tx.marketChallenge.updateMany({
      where: { id: challenge.id, status: 'PENDING_PAYMENT' },
      data:  { status: 'CANCELLED', cancelRequestedBy: requesterId },
    });
    if (guard.count === 0) throw new Error('ALREADY_CANCELLED');

    // Cancel any pending M-Pesa transaction
    await tx.transaction.updateMany({
      where: { challengeId: challenge.id, status: 'PENDING', type: 'CHALLENGE_STAKE' },
      data:  { status: 'FAILED', description: 'Challenge cancelled before M-Pesa confirmed' },
    });

    // Refund each portion to its correct balance bucket
    if (totalRefund > 0) {
      const refundData: any = {};
      if (realRefund  > 0) refundData.balanceKes      = { increment: realRefund  };
      if (bonusRefund > 0) refundData.bonusBalanceKes = { increment: bonusRefund };

      const upd = await tx.user.update({
        where: { id: requesterId },
        data:  refundData,
      });
      await tx.transaction.create({
        data: {
          userId:      requesterId,
          challengeId: challenge.id,
          type:        'REFUND',
          amountKes:   totalRefund,
          balAfter:    Number(upd.balanceKes),
          status:      'SUCCESS',
          description: `Full refund — challenge cancelled. Real: KES ${realRefund}, Bonus: KES ${bonusRefund}`,
        },
      });
    }

    cancellationSucceeded = true;
  }).catch((err: any) => {
    if (err.message === 'ALREADY_CANCELLED') return; // idempotent — silently succeed
    throw err;
  });

  return NextResponse.json({
    success: true,
    status:  'CANCELLED',
    refund:  cancellationSucceeded ? totalRefund : 0,
    fee:     0,
    message: cancellationSucceeded && totalRefund > 0
      ? `Challenge cancelled. KES ${totalRefund.toLocaleString()} refunded in full — KES ${realRefund} to wallet, KES ${bonusRefund} to bonus balance.`
      : 'Challenge cancelled.',
  });
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
