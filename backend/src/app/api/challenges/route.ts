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

const MAX_STAKE = 20000;  // KES 20,000 per person (Social Challenge cap)
const MIN_STAKE = 20;     // KES 20 minimum

const CreateSchema = z.object({
  question:          z.string().min(10).max(200),
  stakePerPerson:    z.number().min(MIN_STAKE).max(MAX_STAKE),
  eventExpiresAt:    z.string().datetime(),
  refereePhone:      z.string().optional(),
  challengerBPhone:  z.string().min(10).max(15),
  isPublic:          z.boolean().default(false),
  resolutionType:    z.enum(['REFEREE', 'MUTUAL', 'TIMER']).default('MUTUAL'),
  // Wallet-first: frontend sends how much to use from wallet vs M-Pesa
  walletAmountKes:   z.number().min(0).optional(),  // amount from real + bonus wallet
  mpesaAmountKes:    z.number().min(0).optional(),  // amount via M-Pesa STK push
});

function normalisePhone(phone: string): string {
  return phone.replace(/\D/g, '').replace(/^0/, '254');
}

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

  // SECURITY: sanitize free-text question before storing — same class of
  // stored XSS protection applied to market proposals (commit 71b3b59).
  // Question is rendered with innerHTML in rada-dashboard.html, so any
  // unsanitized HTML would execute in opponents' browsers.
  const question = sanitizeText(parsed.data.question);

  // ── Validate event expiry ────────────────────────────────────────────────
  if (new Date(eventExpiresAt) <= new Date()) {
    return NextResponse.json({ error: 'Event expiry must be in the future' }, { status: 400 });
  }

  // ── Validate Challenger B ────────────────────────────────────────────────
  const normalisedPhoneB = normalisePhone(challengerBPhone);
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
    const normalisedRefPhone = normalisePhone(refereePhone);
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

  // ── Atomic transaction ────────────────────────────────────────────────────
  const challenge = await prisma.$transaction(async (tx) => {
    const u = await tx.user.findUnique({ where: { id: user.id } });
    if (!u) throw new Error('User not found');

    const currentReal  = Number(u.balanceKes);
    const currentBonus = Number(u.bonusBalanceKes);
    const actualRealUsed  = Math.min(currentReal,  walletTotal);
    const actualBonusUsed = Math.min(currentBonus, Math.max(0, walletTotal - actualRealUsed));
    const actualWalletTotal = actualRealUsed + actualBonusUsed;

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
        userAId:        user.id,
        userBId:        challengerB.id,
        refereeId,
        stakePerPerson,
        totalPool:      walletTotal,  // only wallet portion confirmed; M-Pesa adds to pool on callback
        validatorType:  refereeId ? 'REFEREE' : (resolutionType === 'TIMER' ? 'TIMER' : 'MUTUAL'),
        eventExpiresAt: new Date(eventExpiresAt),
        isPublic,
        status:         mpesaRequired > 0 ? 'PENDING_PAYMENT' : 'PENDING_JOIN',
      },
    });

    const balAfterReal  = currentReal  - actualRealUsed;
    const balAfterBonus = currentBonus - actualBonusUsed;

    // Log wallet deduction transaction
    if (actualWalletTotal > 0) {
      await tx.transaction.create({
        data: {
          userId:      user.id,
          challengeId: ch.id,
          type:        actualBonusUsed > 0 ? 'BONUS_USED' : 'CHALLENGE_STAKE',
          amountKes:   -actualWalletTotal,
          balAfter:    balAfterReal,
          status:      'SUCCESS',
          description: actualBonusUsed > 0
            ? `Challenge stake: KES ${actualRealUsed} wallet + KES ${actualBonusUsed} bonus for "${question.slice(0, 50)}"`
            : `Challenge stake: KES ${actualWalletTotal} from wallet for "${question.slice(0, 50)}"`,
        },
      });
    }

    return ch;
  });

  // ── Trigger M-Pesa STK Push if shortfall ─────────────────────────────────
  // Note: M-Pesa STK Push happens here when mpesaRequired > 0
  // The mpesa/callback will update challenge status to PENDING_JOIN once payment confirmed
  if (mpesaRequired > 0) {
    // TODO: Trigger STK Push via mpesa.service.ts for mpesaRequired amount
    // await mpesaService.stkPush({ phone: freshUser.phone, amount: mpesaRequired, challengeId: challenge.id });
  }

  // ── SMS notifications ─────────────────────────────────────────────────────
  await createNotification({
    userId:  challengerB.id,
    type:    'CHALLENGE_OPPONENT_STAKED',
    title:   '⚡ You\'ve been challenged!',
    message: `${user.name ?? 'Someone'} challenged you on "${question.slice(0, 70)}..." Stake: KES ${stakePerPerson.toLocaleString()}. Code: ${accessCode}`,
    link:    `/join/${accessCode}`,
  });

  if (refereeId) {
    const referee = await prisma.user.findUnique({ where: { id: refereeId } });
    if (referee) {
      await createNotification({
        userId:  referee.id,
        type:    'REFEREE_NOMINATED',
        title:   '⚖ You\'ve been nominated as referee',
        message: `${user.name ?? 'Someone'} nominated you to referee "${question.slice(0, 60)}..." Code: ${accessCode}`,
        link:    `/rada-friends.html`,
      });
    }
  }

  return NextResponse.json({
    success:        true,
    challengeId:    challenge.id,
    accessCode,
    shareUrl:       `${process.env.NEXT_PUBLIC_BASE_URL}/join/${accessCode}`,
    isPublic,
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

  return NextResponse.json({ challenges });
}
