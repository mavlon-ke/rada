import { sanitizeText } from '@/lib/security/middleware';
// src/app/api/challenges/route.ts
// POST — create a Social Challenge with wallet-first payment logic
// GET  — list current user's challenges
//
// Payment order: real balance (balanceKes) first → bonus balance (bonusBalanceKes) → M-Pesa shortfall

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';

import { randomInt } from 'crypto';
import { createNotification } from '@/lib/notifications';
import { displayName }        from '@/lib/user/display-name';
import { stkPush, generateDarajaRef, darajaPhone } from '@/lib/payments/payment.service';
import { withErrorHandling } from '@/lib/security/route-guard';

const MAX_STAKE = 20000;  // KES 20,000 per person (Social Challenge cap)

// dbPhone: normalises to 254XXXXXXXXX for DB lookups (same as darajaPhone output).
function dbPhone(phone: string): string {
  return darajaPhone(phone);
}
const MIN_STAKE = 20;     // KES 20 minimum

const CreateSchema = z.object({
  question:          z.string().min(10).max(200),
  stakePerPerson:    z.number().min(MIN_STAKE).max(MAX_STAKE),
  eventExpiresAt:    z.string().datetime(),
  refereePhone:      z.string().optional(),
  challengerBPhone:  z.string().min(10).max(15),
  isPublic:          z.boolean().default(false),
  resolutionType:    z.enum(['REFEREE', 'MUTUAL', 'TIMER']).default('MUTUAL'),
  challengerAAlias:  z.string().max(40).optional(),
  challengerBAlias:  z.string().max(40).optional(),
  walletAmountKes:   z.number().min(0).optional(),
  mpesaAmountKes:    z.number().min(0).optional(),
});

async function generateAccessCode(): Promise<string> {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code: string;
  let exists = true;
  while (exists) {
    code = Array.from({ length: 6 }, () => chars[randomInt(chars.length)]).join('');
    exists = !!(await prisma.marketChallenge.findUnique({ where: { accessCode: code } }));
  }
  return code!;
}

export const POST = withErrorHandling(async function POST(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json();
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const {
    stakePerPerson, eventExpiresAt,
    refereePhone, challengerBPhone, isPublic, resolutionType,
    walletAmountKes, mpesaAmountKes,
  } = parsed.data;

  const question          = sanitizeText(parsed.data.question);
  const challengerAAlias  = parsed.data.challengerAAlias
    ? sanitizeText(parsed.data.challengerAAlias) : undefined;
  const challengerBAlias  = parsed.data.challengerBAlias
    ? sanitizeText(parsed.data.challengerBAlias) : undefined;

  if (new Date(eventExpiresAt) <= new Date()) {
    return NextResponse.json({ error: 'Event expiry must be in the future' }, { status: 400 });
  }

  const normalisedPhoneB = dbPhone(challengerBPhone);
  const challengerB = await prisma.user.findUnique({ where: { phone: normalisedPhoneB } });
  if (!challengerB) {
    return NextResponse.json({
      error: 'Challenger B is not a registered CheckRada user. They need to sign up first.',
    }, { status: 400 });
  }
  if (challengerB.id === user.id) {
    return NextResponse.json({ error: 'You cannot challenge yourself' }, { status: 400 });
  }

  let refereeId: string | undefined;
  if (refereePhone) {
    const normalisedRefPhone = dbPhone(refereePhone);
    const refUser = await prisma.user.findUnique({ where: { phone: normalisedRefPhone } });
    if (!refUser) {
      return NextResponse.json({ error: 'Referee is not a registered CheckRada user.' }, { status: 400 });
    }
    if (refUser.id === user.id)         return NextResponse.json({ error: 'You cannot be your own referee' }, { status: 400 });
    if (refUser.id === challengerB.id)  return NextResponse.json({ error: 'Referee cannot be one of the challengers' }, { status: 400 });
    refereeId = refUser.id;
  }

  const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
  if (!freshUser) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const realBal  = Number(freshUser.balanceKes);
  const bonusBal = Number(freshUser.bonusBalanceKes);

  const realUsed  = Math.min(realBal,  stakePerPerson);
  const bonusUsed = Math.min(bonusBal, Math.max(0, stakePerPerson - realUsed));
  const walletTotal = realUsed + bonusUsed;
  const mpesaRequired = Math.max(0, stakePerPerson - walletTotal);

  if (walletAmountKes !== undefined && mpesaAmountKes !== undefined) {
    const provided = walletAmountKes + mpesaAmountKes;
    if (Math.abs(provided - stakePerPerson) > 1) {
      return NextResponse.json({ error: 'Payment amounts do not match stake' }, { status: 400 });
    }
  }

  if (walletTotal < stakePerPerson && mpesaRequired === 0) {
    return NextResponse.json({ error: 'Insufficient balance. Please deposit first.' }, { status: 400 });
  }

  const accessCode = await generateAccessCode();

  let actualRealUsedOut  = 0;
  let actualBonusUsedOut = 0;

  const challenge = await prisma.$transaction(async (tx) => {
    const u = await tx.user.findUnique({ where: { id: user.id } });
    if (!u) throw new Error('User not found');

    const currentReal  = Number(u.balanceKes);
    const currentBonus = Number(u.bonusBalanceKes);
    const actualRealUsed  = Math.min(currentReal,  walletTotal);
    const actualBonusUsed = Math.min(currentBonus, Math.max(0, walletTotal - actualRealUsed));
    const actualWalletTotal = actualRealUsed + actualBonusUsed;
    actualRealUsedOut  = actualRealUsed;
    actualBonusUsedOut = actualBonusUsed;

    if (actualWalletTotal < walletTotal) throw new Error('Insufficient balance');

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

    const ch = await tx.marketChallenge.create({
      data: {
        question,
        accessCode,
        userAId:          user.id,
        userBId:          challengerB.id,
        refereeId,
        stakePerPerson,
        challengerAAlias: challengerAAlias || null,
        challengerBAlias: challengerBAlias || null,
        totalPool:        walletTotal,
        validatorType:    refereeId ? 'REFEREE' : (resolutionType === 'TIMER' ? 'TIMER' : 'MUTUAL'),
        eventExpiresAt:   new Date(eventExpiresAt),
        isPublic,
        status:           mpesaRequired > 0 ? 'PENDING_PAYMENT' : 'PENDING_JOIN',
      },
    });

    const balAfterReal  = currentReal  - actualRealUsed;
    const balAfterBonus = currentBonus - actualBonusUsed;

    if (actualRealUsed > 0) {
      await tx.transaction.create({
        data: {
          userId:      user.id,
          challengeId: ch.id,
          type:        'CHALLENGE_STAKE',
          amountKes:   -actualRealUsed,
          balAfter:    balAfterReal,
          status:      'SUCCESS',
          description: `Challenge stake (real balance): KES ${actualRealUsed} for "${question.slice(0, 50)}"`,
        },
      });
    }
    if (actualBonusUsed > 0) {
      await tx.transaction.create({
        data: {
          userId:      user.id,
          challengeId: ch.id,
          type:        'BONUS_USED',
          amountKes:   -actualBonusUsed,
          balAfter:    balAfterBonus,
          status:      'SUCCESS',
          description: `Challenge stake (bonus balance): KES ${actualBonusUsed} for "${question.slice(0, 50)}"`,
        },
      });
    }

    return ch;
  });

  // ── M-Pesa STK Push for wallet shortfall (Daraja) ────────────────────────
  let stkMessage: string | null = null;

  if (mpesaRequired > 0) {
    const accountRef = generateDarajaRef('CRC');
    const phone      = darajaPhone(freshUser.phone);

    try {
      const pending = await prisma.transaction.create({
        data: {
          userId:      user.id,
          challengeId: challenge.id,
          type:        'CHALLENGE_STAKE',
          amountKes:   mpesaRequired,
          balAfter:    Number(freshUser.balanceKes) - actualRealUsedOut,
          phone,
          mpesaRef:    accountRef,
          status:      'PENDING',
          description: `Challenge M-Pesa payment: KES ${mpesaRequired} for "${question.slice(0, 50)}"`,
        },
      });

      const stkResult = await stkPush({
        amountKes:        mpesaRequired,
        phone,
        accountReference: accountRef,
        transactionDesc:  'CheckRada Chg',
      });

      // Update mpesaRef to CheckoutRequestID for STK callback lookup
      await prisma.transaction.update({
        where: { id: pending.id },
        data:  { mpesaRef: stkResult.CheckoutRequestID },
      }).catch((err: any) => {
        console.error(
          `[Challenge] CRITICAL: mpesaRef update failed tx=${pending.id} ` +
          `accountRef=${accountRef} CheckoutRequestID=${stkResult.CheckoutRequestID} err=${err.message}`
        );
      });

      stkMessage = stkResult.CustomerMessage || 'Check your phone for an M-Pesa prompt.';
      console.log(`[Challenge] STK Push sent for challenge ${challenge.id} — KES ${mpesaRequired}`);

    } catch (stkErr: any) {
      console.error('[Challenge] STK Push failed:', stkErr.message);

      await prisma.$transaction(async (tx) => {
        await tx.marketChallenge.update({
          where: { id: challenge.id },
          data:  { status: 'CANCELLED' },
        });
        if (actualRealUsedOut > 0 || actualBonusUsedOut > 0) {
          await tx.user.update({
            where: { id: user.id },
            data: {
              ...(actualRealUsedOut  > 0 ? { balanceKes:      { increment: actualRealUsedOut  } } : {}),
              ...(actualBonusUsedOut > 0 ? { bonusBalanceKes: { increment: actualBonusUsedOut } } : {}),
            },
          });
        }
      });

      return NextResponse.json({
        error: `Could not initiate M-Pesa payment: ${stkErr.message}. Your wallet balance has been refunded.`,
      }, { status: 500 });
    }
  }

  if (mpesaRequired === 0) {
    await createNotification({
      userId:  challengerB.id,
      type:    'CHALLENGE_OPPONENT_STAKED',
      title:   "⚡ You've been challenged!",
      message: `${displayName(user.name, user.phone)} challenged you on "${question.slice(0, 70)}..." Stake: KES ${stakePerPerson.toLocaleString()}. Code: ${accessCode}`,
      link:    `/join/${accessCode}`,
      whatsapp: {
        template:   'CHALLENGE_OPPONENT_STAKED',
        parameters: [displayName(user.name, user.phone), stakePerPerson.toLocaleString()],
      },
    });
  }

  if (refereeId) {
    const referee = await prisma.user.findUnique({ where: { id: refereeId } });
    if (referee) {
      await createNotification({
        userId:  referee.id,
        type:    'REFEREE_NOMINATED',
        title:   "⚖ You've been nominated as referee",
        message: `${displayName(user.name, user.phone)} nominated you to referee "${question.slice(0, 60)}..." Code: ${accessCode}`,
        link:    `/rada-friends.html`,
        whatsapp: {
          template:   'REFEREE_NOMINATED',
          parameters: [displayName(user.name, user.phone)],
        },
      });
    }
  }

  return NextResponse.json({
    success:        true,
    challengeId:    challenge.id,
    accessCode,
    shareUrl:       `${process.env.NEXT_PUBLIC_BASE_URL}/join/${accessCode}`,
    isPublic,
    stkMessage,
    payment: {
      walletUsed:    walletTotal,
      realUsed:      realUsed,
      bonusUsed:     bonusUsed,
      mpesaRequired: mpesaRequired,
    },
  });
});

export const GET = withErrorHandling(async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const challenges = await prisma.marketChallenge.findMany({
    where: {
      OR: [
        { userAId: user.id },
        { userBId: user.id },
        { refereeId: user.id },
      ],
    },
    orderBy: { createdAt: 'desc' },
    include: {
      userA:   { select: { id: true, name: true, phone: true } },
      userB:   { select: { id: true, name: true, phone: true } },
      referee: { select: { id: true, name: true, phone: true } },
    },
  });

  return NextResponse.json({
    challenges: challenges.map(c => ({
      ...c,
      userA:   c.userA   ? { ...c.userA,   name: displayName(c.userA.name,   c.userA.phone)   } : null,
      userB:   c.userB   ? { ...c.userB,   name: displayName(c.userB.name,   c.userB.phone)   } : null,
      referee: c.referee ? { ...c.referee, name: displayName(c.referee.name, c.referee.phone) } : null,
    })),
  });
});
