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
import {
  chargeMpesa,
  generateReference,
  normalisePhone,
} from '@/lib/paystack/paystack.service';

const MAX_STAKE = 20000;  // KES 20,000 per person (Social Challenge cap)

// dbPhone: strips leading + for DB lookups (users stored as 254XXXXXXXXX, not +254XXXXXXXXX).
function dbPhone(phone: string): string {
  return normalisePhone(phone).replace(/^\+/, '');
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
  challengerAAlias:  z.string().max(40).optional(),   // optional nickname for creator
  challengerBAlias:  z.string().max(40).optional(),   // optional nickname for opponent
  // Wallet-first: frontend sends how much to use from wallet vs M-Pesa
  walletAmountKes:   z.number().min(0).optional(),  // amount from real + bonus wallet
  mpesaAmountKes:    z.number().min(0).optional(),  // amount via M-Pesa STK push
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

export async function POST(req: NextRequest) {
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
  // challengerAAlias and challengerBAlias are declared below with sanitization.

  // SECURITY: sanitize free-text question before storing — same class of
  // stored XSS protection applied to market proposals (commit 71b3b59).
  // Question is rendered with innerHTML in rada-dashboard.html, so any
  // unsanitized HTML would execute in opponents' browsers.
  const question          = sanitizeText(parsed.data.question);
  const challengerAAlias  = parsed.data.challengerAAlias
    ? sanitizeText(parsed.data.challengerAAlias) : undefined;
  const challengerBAlias  = parsed.data.challengerBAlias
    ? sanitizeText(parsed.data.challengerBAlias) : undefined;

  // ── Validate event expiry ────────────────────────────────────────────────
  if (new Date(eventExpiresAt) <= new Date()) {
    return NextResponse.json({ error: 'Event expiry must be in the future' }, { status: 400 });
  }

  // ── Validate Challenger B ────────────────────────────────────────────────
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

  // ── Validate referee ─────────────────────────────────────────────────────
  let refereeId: string | undefined;
  if (refereePhone) {
    const normalisedRefPhone = dbPhone(refereePhone);
    const refUser = await prisma.user.findUnique({ where: { phone: normalisedRefPhone } });
    if (!refUser) {
      return NextResponse.json({
        error: 'Referee is not a registered CheckRada user.',
      }, { status: 400 });
    }
    if (refUser.id === user.id)         return NextResponse.json({ error: 'You cannot be your own referee' }, { status: 400 });
    if (refUser.id === challengerB.id)  return NextResponse.json({ error: 'Referee cannot be one of the challengers' }, { status: 400 });
    refereeId = refUser.id;
  }

  // ── Wallet-first payment logic ───────────────────────────────────────────
  // Read fresh balances
  const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
  if (!freshUser) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const realBal  = Number(freshUser.balanceKes);
  const bonusBal = Number(freshUser.bonusBalanceKes);
  const totalAvailable = realBal + bonusBal;

  // Calculate how much from each source
  const realUsed  = Math.min(realBal,  stakePerPerson);
  const bonusUsed = Math.min(bonusBal, Math.max(0, stakePerPerson - realUsed));
  const walletTotal = realUsed + bonusUsed;
  const mpesaRequired = Math.max(0, stakePerPerson - walletTotal);

  // If caller provided explicit amounts, validate they add up to the stake
  if (walletAmountKes !== undefined && mpesaAmountKes !== undefined) {
    const provided = walletAmountKes + mpesaAmountKes;
    if (Math.abs(provided - stakePerPerson) > 1) {
      return NextResponse.json({ error: 'Payment amounts do not match stake' }, { status: 400 });
    }
  }

  // Must have enough combined balance + M-Pesa to cover stake
  // (if mpesaRequired > 0, the M-Pesa callback will credit the account before stake fires)
  // For wallet-only or partial wallet — validate wallet covers its portion
  if (walletTotal < stakePerPerson && mpesaRequired === 0) {
    return NextResponse.json({ error: 'Insufficient balance. Please deposit first.' }, { status: 400 });
  }

  const accessCode = await generateAccessCode();

  // Hoisted outside transaction so they're accessible for STK push rollback
  let actualRealUsedOut  = 0;
  let actualBonusUsedOut = 0;

  // ── Atomic transaction ────────────────────────────────────────────────────
  const challenge = await prisma.$transaction(async (tx) => {
    const u = await tx.user.findUnique({ where: { id: user.id } });
    if (!u) throw new Error('User not found');

    const currentReal  = Number(u.balanceKes);
    const currentBonus = Number(u.bonusBalanceKes);
    const actualRealUsed  = Math.min(currentReal,  walletTotal);
    const actualBonusUsed = Math.min(currentBonus, Math.max(0, walletTotal - actualRealUsed));
    const actualWalletTotal = actualRealUsed + actualBonusUsed;
    // Expose to outer scope for STK push rollback
    actualRealUsedOut  = actualRealUsed;
    actualBonusUsedOut = actualBonusUsed;

    // Validate sufficient wallet funds for the wallet portion
    if (actualWalletTotal < walletTotal) {
      throw new Error('Insufficient balance');
    }

    // Deduct from real balance first
    const updateData: any = {};
    if (actualRealUsed > 0) {
      updateData.balanceKes = { decrement: actualRealUsed };
    }
    // Deduct from bonus balance
    if (actualBonusUsed > 0) {
      updateData.bonusBalanceKes = { decrement: actualBonusUsed };
    }
    if (Object.keys(updateData).length > 0) {
      await tx.user.update({ where: { id: user.id }, data: updateData });
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
        totalPool:      walletTotal,  // only wallet portion confirmed; M-Pesa adds to pool on callback
        validatorType:  refereeId ? 'REFEREE' : (resolutionType === 'TIMER' ? 'TIMER' : 'MUTUAL'),
        eventExpiresAt: new Date(eventExpiresAt),
        isPublic,
        status:         mpesaRequired > 0 ? 'PENDING_PAYMENT' : 'PENDING_JOIN',
      },
    });

    const balAfterReal  = currentReal  - actualRealUsed;
    const balAfterBonus = currentBonus - actualBonusUsed;

    // Log wallet deduction — two separate records for precise refund tracking.
    // CHALLENGE_STAKE = real balance used; BONUS_USED = bonus balance used.
    // cancelPendingPayment reads these by type to refund each to the correct bucket.
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

  // ── Trigger M-Pesa STK Push for wallet shortfall ────────────────────────
  // When the user's wallet doesn't fully cover the stake, we trigger an STK push
  // for the shortfall. The webhook (charge.success) will move the challenge from
  // PENDING_PAYMENT → PENDING_JOIN and notify Challenger B once payment is confirmed.
  // On STK push failure: challenge is cancelled and wallet portion is refunded.
  let stkMessage: string | null = null;

  if (mpesaRequired > 0) {
    const ref          = generateReference('CHG');
    const formattedPhone = normalisePhone(freshUser.phone);
    const email        = `${formattedPhone.replace('+', '')}@checkrada.co.ke`;

    try {
      // Record the pending M-Pesa payment — webhook identifies it by mpesaRef
      await prisma.transaction.create({
        data: {
          userId:      user.id,
          challengeId: challenge.id,
          type:        'CHALLENGE_STAKE',
          amountKes:   mpesaRequired,
          balAfter:    Number(freshUser.balanceKes) - actualRealUsedOut,
          phone:       formattedPhone,
          mpesaRef:    ref,
          status:      'PENDING',
          description: `Challenge M-Pesa payment: KES ${mpesaRequired} for "${question.slice(0, 50)}"`,
        },
      });

      const stkResult = await chargeMpesa({
        email,
        amountKes:  mpesaRequired,
        phone:      formattedPhone,
        reference:  ref,
        metadata: {
          userId:      user.id,
          challengeId: challenge.id,
          platform:    'checkrada',
          paymentType: 'challenge_stake',
        },
      });

      stkMessage = stkResult.display_text || 'Check your phone for an M-Pesa prompt.';
      console.log(`[Challenge] STK Push sent for challenge ${challenge.id} — KES ${mpesaRequired}`);

    } catch (stkErr: any) {
      // STK push failed — cancel the challenge and refund the wallet portion
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

  // ── Notifications ─────────────────────────────────────────────────────────
  // Challenger B is only notified once the challenge is PENDING_JOIN.
  // When mpesaRequired > 0, Challenger B will be notified from the webhook
  // after M-Pesa confirms — otherwise they'd try to join a PENDING_PAYMENT challenge.
  if (mpesaRequired === 0) {
    await createNotification({
      userId:  challengerB.id,
      type:    'CHALLENGE_OPPONENT_STAKED',
      title:   '⚡ You\'ve been challenged!',
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
        title:   '⚖ You\'ve been nominated as referee',
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
    stkMessage,               // null when no M-Pesa needed; STK prompt text otherwise
    payment: {
      walletUsed:    walletTotal,
      realUsed:      realUsed,
      bonusUsed:     bonusUsed,
      mpesaRequired: mpesaRequired,
    },
  });
}

export async function GET(req: NextRequest) {
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
}
