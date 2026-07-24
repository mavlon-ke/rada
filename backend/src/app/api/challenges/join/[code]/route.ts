// src/app/api/challenges/join/[code]/route.ts
// GET  — look up a challenge by access code (preview before staking)
// POST — join the challenge and stake your amount
//
// Locked challenges (userBId set at creation): only the pre-assigned user can join.
// Open challenges (userBId null): first registered user with the code wins the slot.
//
// Payment: wallet-first (real → bonus). B must have full stake in wallet before joining.

import { NextRequest, NextResponse } from 'next/server';
import { prisma }             from '@/lib/db/prisma';
import { requireAuth }        from '@/lib/auth/session';
import { createNotification } from '@/lib/notifications';
import { displayName }        from '@/lib/user/display-name';
import { withErrorHandling } from '@/lib/security/route-guard';

// ── Referee challenge join (PENDING_BOTH / PENDING_A / PENDING_B) ──────────────
// A and B join independently using the same code.
// The backend determines their role from userAId / userBId.
// B joining first → PENDING_A. A joining first → PENDING_B. Both joined → ACTIVE.
// Referee (R) cannot join their own challenge.
// Wallet must fully cover stake — no M-Pesa STK for joining.

async function handleRefereeJoin(challenge: any, user: any, freshUser: any) {
  const isA = challenge.userAId === user.id;
  const isB = challenge.userBId === user.id;
  const isR = challenge.refereeId === user.id;

  if (isR) {
    return NextResponse.json({ error: 'The referee cannot join their own challenge' }, { status: 403 });
  }
  if (!isA && !isB) {
    return NextResponse.json({ error: 'You are not a participant in this challenge' }, { status: 403 });
  }

  // Guard: cannot re-stake if already done
  if (isA && challenge.status === 'PENDING_B') {
    return NextResponse.json({ error: 'You have already staked in this challenge' }, { status: 400 });
  }
  if (isB && challenge.status === 'PENDING_A') {
    return NextResponse.json({ error: 'You have already staked in this challenge' }, { status: 400 });
  }
  if (challenge.status === 'PENDING_A' && !isA) {
    return NextResponse.json({ error: 'This slot is reserved for the other participant' }, { status: 403 });
  }
  if (challenge.status === 'PENDING_B' && !isB) {
    return NextResponse.json({ error: 'This slot is reserved for the other participant' }, { status: 403 });
  }

  const stake    = Number(challenge.stakePerPerson);
  const realBal  = Number(freshUser.balanceKes);
  const bonusBal = Number(freshUser.bonusBalanceKes);
  const walletTotal = realBal + bonusBal;

  if (walletTotal < stake) {
    const shortfall = Math.ceil(stake - walletTotal);
    return NextResponse.json({
      error: 'Insufficient balance. You need KES ' + shortfall.toLocaleString() + ' more to join. Please deposit first.',
    }, { status: 400 });
  }

  const realUsed  = Math.min(realBal,  stake);
  const bonusUsed = Math.min(bonusBal, Math.max(0, stake - realUsed));

  // Determine status transition
  const newStatus = challenge.status === 'PENDING_BOTH'
    ? (isA ? 'PENDING_B' : 'PENDING_A')   // first joiner
    : 'ACTIVE';                             // second joiner — both have staked

  let actualRealUsed  = 0;
  let actualBonusUsed = 0;

  const updated = await prisma.$transaction(async (tx: any) => {
    const u = await tx.user.findUnique({ where: { id: user.id } });
    const curReal  = Number(u.balanceKes);
    const curBonus = Number(u.bonusBalanceKes);
    actualRealUsed  = Math.min(curReal,  stake);
    actualBonusUsed = Math.min(curBonus, Math.max(0, stake - actualRealUsed));

    if (actualRealUsed + actualBonusUsed < stake) throw new Error('Insufficient balance');

    const updateData: any = {};
    if (actualRealUsed  > 0) updateData.balanceKes      = { decrement: actualRealUsed  };
    if (actualBonusUsed > 0) updateData.bonusBalanceKes = { decrement: actualBonusUsed };
    if (Object.keys(updateData).length > 0) {
      const whereGuard: any = { id: user.id };
      if (actualRealUsed  > 0) whereGuard.balanceKes      = { gte: actualRealUsed  };
      if (actualBonusUsed > 0) whereGuard.bonusBalanceKes = { gte: actualBonusUsed };
      const balUpdated = await tx.user.updateMany({ where: whereGuard, data: updateData });
      if (balUpdated.count === 0) throw new Error('Insufficient balance');
    }

    const claimedCh = await tx.marketChallenge.updateMany({
      where: { id: challenge.id, status: challenge.status },
      data:  { totalPool: { increment: stake }, status: newStatus },
    });
    if (claimedCh.count === 0) throw new Error('Challenge slot already taken');
    const ch = await tx.marketChallenge.findUnique({ where: { id: challenge.id } });

    await tx.transaction.create({
      data: {
        userId:      user.id,
        challengeId: ch.id,
        type:        actualBonusUsed > 0 ? 'BONUS_USED' : 'CHALLENGE_STAKE',
        amountKes:   -(actualRealUsed + actualBonusUsed),
        balAfter:    curReal - actualRealUsed,
        status:      'SUCCESS',
        description: 'Joined referee challenge as ' + (isA ? 'Challenger A' : 'Challenger B'),
      },
    });

    return ch;
  });

  const joinerName = displayName(user.name, freshUser.phone);
  const otherId    = isA ? challenge.userBId : challenge.userAId;

  if (newStatus === 'ACTIVE') {
    // Both staked — notify both parties and referee
    const msg = 'Both challengers have staked for "' + challenge.question.slice(0, 50) + '". The challenge is now live.';
    if (challenge.userAId) {
      void createNotification({ userId: challenge.userAId, type: 'CHALLENGE_OPPONENT_STAKED',
        title: '🔴 Challenge is live!', message: msg, link: '/rada-friends.html' });
    }
    if (challenge.userBId) {
      void createNotification({ userId: challenge.userBId, type: 'CHALLENGE_OPPONENT_STAKED',
        title: '🔴 Challenge is live!', message: msg, link: '/rada-friends.html' });
    }
    if (challenge.refereeId) {
      void createNotification({ userId: challenge.refereeId, type: 'REFEREE_NOMINATED',
        title: '⚖️ Both challengers have staked',
        message: 'Both parties have staked for "' + challenge.question.slice(0, 50) + '". You can now resolve once the event occurs.',
        link: '/rada-friends.html' });
    }
  } else {
    // First joiner — notify the other party (blind: just stake amount)
    if (otherId) {
      void createNotification({
        userId:  otherId,
        type:    'CHALLENGE_OPPONENT_STAKED',
        title:   '⚡ Your opponent has staked!',
        message: 'Your opponent has accepted the challenge. Stake KES ' + stake.toLocaleString() + ' using code ' + challenge.accessCode + ' to make it live.',
        link:    '/join/' + challenge.accessCode,
        whatsapp: {
          template:   'CHALLENGE_OPPONENT_STAKED',
          parameters: ['your opponent', stake.toLocaleString()],
        },
      });
    }
  }

  return NextResponse.json({
    success:    true,
    challengeId: updated.id,
    status:     newStatus,
    payment: { walletUsed: actualRealUsed + actualBonusUsed },
  });
}

export const GET = withErrorHandling(async function GET(
  _req: NextRequest,
  { params }: { params: { code: string } }
) {
  const challenge = await prisma.marketChallenge.findUnique({
    where:   { accessCode: params.code.toUpperCase() },
    include: {
      userA:   { select: { name: true, phone: true } },
      referee: { select: { name: true, phone: true } },
    },
  });

  if (!challenge) return NextResponse.json({ error: 'Challenge not found' }, { status: 404 });

  const joinableStatuses = ['PENDING_JOIN', 'PENDING_BOTH', 'PENDING_A', 'PENDING_B'];
  if (!joinableStatuses.includes(challenge.status)) {
    return NextResponse.json({ error: 'This challenge is no longer open to join' }, { status: 400 });
  }

  const isRefCreated = ['PENDING_BOTH','PENDING_A','PENDING_B'].includes(challenge.status);

  return NextResponse.json({
    challengeId:      challenge.id,
    question:         challenge.question,
    stakePerPerson:   Number(challenge.stakePerPerson),
    eventExpiresAt:   challenge.eventExpiresAt,
    validatorType:    challenge.validatorType,
    status:           challenge.status,
    // For referee-created: show referee name; creator field stays blind
    createdBy:        isRefCreated
      ? (challenge.referee ? displayName(challenge.referee.name, challenge.referee.phone) : 'Referee')
      : displayName(challenge.userA.name, challenge.userA.phone),
    challengerAAlias: challenge.challengerAAlias || null,
    challengerBAlias: challenge.challengerBAlias || null,
    hasReferee:       !!challenge.refereeId,
    refereeName:      challenge.referee ? displayName(challenge.referee.name, challenge.referee.phone) : null,
    isLocked:         !!challenge.userBId,
    isRefCreated,
  });
});

export const POST = withErrorHandling(async function POST(
  req: NextRequest,
  { params }: { params: { code: string } }
) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const challenge = await prisma.marketChallenge.findUnique({
    where:   { accessCode: params.code.toUpperCase() },
    include: { userA: { select: { phone: true, name: true } } },
  });

  if (!challenge) {
    return NextResponse.json({ error: 'Challenge not found' }, { status: 404 });
  }
  const joinableStatuses = ['PENDING_JOIN', 'PENDING_BOTH', 'PENDING_A', 'PENDING_B'];
  if (!joinableStatuses.includes(challenge.status)) {
    return NextResponse.json({ error: 'This challenge is no longer open to join' }, { status: 400 });
  }

  const stake = Number(challenge.stakePerPerson);

  // ── Read fresh balances before any join path ──────────────────────────────
  // Must be declared here — used by both referee and regular join paths.
  const freshUser = await prisma.user.findUnique({
    where:  { id: user.id },
    select: { balanceKes: true, bonusBalanceKes: true, phone: true, name: true },
  });
  if (!freshUser) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  // ── Referee-created challenge: handle PENDING_BOTH / PENDING_A / PENDING_B ─
  if (['PENDING_BOTH', 'PENDING_A', 'PENDING_B'].includes(challenge.status)) {
    return handleRefereeJoin(challenge, user, freshUser);
  }

  // ── Regular challenge (PENDING_JOIN) ──────────────────────────────────────
  if (challenge.userAId === user.id) {
    return NextResponse.json({ error: 'You created this challenge' }, { status: 400 });
  }

  // Locked challenge: enforce pre-assigned Challenger B
  if (challenge.userBId && challenge.userBId !== user.id) {
    return NextResponse.json({
      error: 'This challenge is reserved for a specific person and cannot be joined with this code.',
    }, { status: 403 });
  }

  const realBal  = Number(freshUser.balanceKes);
  const bonusBal = Number(freshUser.bonusBalanceKes);
  const walletTotal = realBal + bonusBal;

  // B must have full stake in wallet. No M-Pesa STK push at join time —
  // if B misses the prompt or enters the wrong PIN there is no retry path.
  // They should deposit first, then join.
  if (walletTotal < stake) {
    const shortfall = Math.ceil(stake - walletTotal);
    return NextResponse.json({
      error: `Insufficient balance. You need KES ${shortfall.toLocaleString()} more to join. Please deposit first then try again.`,
    }, { status: 400 });
  }

  const realUsed  = Math.min(realBal,  stake);
  const bonusUsed = Math.min(bonusBal, Math.max(0, stake - realUsed));

  // ── Atomic transaction: deduct wallet + activate challenge ────────────────
  // actualRealUsed / actualBonusUsed are set inside tx and used for the transaction record
  let actualRealUsed  = 0;
  let actualBonusUsed = 0;

  const updated = await prisma.$transaction(async (tx: any) => {
    const u = await tx.user.findUnique({ where: { id: user.id } });
    if (!u) throw new Error('User not found');

    const curReal  = Number(u.balanceKes);
    const curBonus = Number(u.bonusBalanceKes);
    // Use stake (not walletTotal) — walletTotal is the balance check total, not deduction amount
    actualRealUsed  = Math.min(curReal,  stake);
    actualBonusUsed = Math.min(curBonus, Math.max(0, stake - actualRealUsed));
    const actualWalletTotal = actualRealUsed + actualBonusUsed;

    if (actualWalletTotal < stake) throw new Error('Insufficient balance');

    const updateData: any = {};
    if (actualRealUsed  > 0) updateData.balanceKes      = { decrement: actualRealUsed  };
    if (actualBonusUsed > 0) updateData.bonusBalanceKes = { decrement: actualBonusUsed };
    if (Object.keys(updateData).length > 0) {
      const whereGuard: any = { id: user.id };
      if (actualRealUsed  > 0) whereGuard.balanceKes      = { gte: actualRealUsed  };
      if (actualBonusUsed > 0) whereGuard.bonusBalanceKes = { gte: actualBonusUsed };
      const balUpdated = await tx.user.updateMany({ where: whereGuard, data: updateData });
      if (balUpdated.count === 0) throw new Error('Insufficient balance');
    }

    // H-4 FIX: status guard prevents two users joining simultaneously.
    // If another request already set userBId or changed status, this update
    // fails (Prisma P2025) and the $transaction rolls back — wallet is safe.
    const ch = await tx.marketChallenge.update({
      where: {
        id:      challenge.id,
        status:  'PENDING_JOIN', // only join if still open
        userBId: null,           // only join if not already claimed
      },
      data: {
        userBId:   user.id,
        totalPool: { increment: actualWalletTotal },
        status:    'ACTIVE',
      },
    });

    if (actualWalletTotal > 0) {
      await tx.transaction.create({
        data: {
          userId:      user.id,
          challengeId: ch.id,
          type:        actualBonusUsed > 0 ? 'BONUS_USED' : 'CHALLENGE_STAKE',
          amountKes:   -actualWalletTotal,
          balAfter:    curReal - actualRealUsed,
          status:      'SUCCESS',
          description: `Joined challenge: "${challenge.question.slice(0, 60)}"`,
        },
      });
    }

    return ch;
  });

  // ── Notify creator ────────────────────────────────────────────────────────
  const joinerName = displayName(user.name, freshUser.phone);
  void createNotification({
    userId:  challenge.userAId,
    type:    'CHALLENGE_OPPONENT_STAKED',
    title:   '🤝 Challenge accepted!',
    message: `${joinerName} accepted your challenge "${challenge.question.slice(0, 50)}...". Pool: KES ${Number(updated.totalPool).toLocaleString()}`,
    link:    '/rada-friends.html',
    whatsapp: {
      template:   'CHALLENGE_OPPONENT_STAKED',
      parameters: [joinerName, Number(updated.totalPool).toLocaleString()],
    },
  });

  return NextResponse.json({
    success:     true,
    challengeId: updated.id,
    status:      'ACTIVE',
    payment: {
      walletUsed: walletTotal,
    },
  });
});
