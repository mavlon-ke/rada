// src/app/api/challenges/batch/route.ts
// Create up to 100 Social Challenges from one submission.
// Same question, resolution type, and deadline apply to all friends.
// Each friend can have a different stake amount and optional nickname.
//
// Payment: sequential wallet fill (Friend 1 first, Friend 2 from remainder, etc.)
// One combined M-Pesa STK push for the total shortfall across all challenges.
//
// Invalid phones: skipped (reported back), valid ones proceed.
// The batch shares a batchId so the webhook can activate all on one M-Pesa confirm.

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { randomInt } from 'crypto';
import { prisma }             from '@/lib/db/prisma';
import { requireAuth }        from '@/lib/auth/session';
import { createNotification } from '@/lib/notifications';
import { displayName }        from '@/lib/user/display-name';
import { sanitizeText }       from '@/lib/security/middleware';
import {
  chargeMpesa,
  generateReference,
  normalisePhone,
} from '@/lib/paystack/paystack.service';


// dbPhone: strips leading + for DB lookups (users stored as 254XXXXXXXXX, not +254XXXXXXXXX).
function dbPhone(phone: string): string {
  return normalisePhone(phone).replace(/^\+/, '');
}
const MAX_FRIENDS = 100;
const MIN_STAKE   = 20;
const MAX_STAKE   = 20000;

const FriendSchema = z.object({
  phone:         z.string().min(10).max(15).optional(),  // omit = open challenge
  nickname:      z.string().max(40).optional(),
  stakePerPerson: z.number().min(MIN_STAKE).max(MAX_STAKE),
});

const BatchSchema = z.object({
  question:         z.string().min(10).max(200),
  friends:          z.array(FriendSchema).min(1).max(MAX_FRIENDS),
  resolutionType:   z.enum(['REFEREE', 'MUTUAL', 'TIMER']).default('MUTUAL'),
  refereePhone:     z.string().optional(),
  eventExpiresAt:   z.string().datetime(),
  challengerAAlias: z.string().max(40).optional(),
  isPublic:         z.boolean().default(false),
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
  const parsed = BatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { friends, resolutionType, refereePhone, eventExpiresAt, isPublic, challengerAAlias } = parsed.data;
  const question = sanitizeText(parsed.data.question);

  if (new Date(eventExpiresAt) <= new Date()) {
    return NextResponse.json({ error: 'Event expiry must be in the future' }, { status: 400 });
  }

  // ── Validate referee ──────────────────────────────────────────────────────
  let refereeId: string | undefined;
  if (refereePhone) {
    const refUser = await prisma.user.findUnique({ where: { phone: dbPhone(refereePhone) } });
    if (!refUser) return NextResponse.json({ error: 'Referee is not a registered CheckRada user.' }, { status: 400 });
    if (refUser.id === user.id) return NextResponse.json({ error: 'You cannot be your own referee' }, { status: 400 });
    refereeId = refUser.id;
  }

  // ── Pre-flight: validate all friend phones ────────────────────────────────
  const skipped: Array<{ phone: string; reason: string }> = [];
  const valid:   Array<{
    phone:          string | null;
    nickname?:      string;
    stakePerPerson: number;
    userId:         string | null;
    userName:       string | null;
    userPhone:      string | null;
  }> = [];

  for (const f of friends) {
    // No phone = open challenge; anyone with the code can join
    if (!f.phone) {
      valid.push({
        phone:          null,
        nickname:       f.nickname,
        stakePerPerson: f.stakePerPerson,
        userId:         null,      // not pre-assigned
        userName:       null,
        userPhone:      null,
      });
      continue;
    }

    const normPhone = dbPhone(f.phone);
    if (normPhone === dbPhone(user.phone)) {
      skipped.push({ phone: f.phone, reason: 'Cannot challenge yourself' });
      continue;
    }
    const found = await prisma.user.findUnique({ where: { phone: normPhone } });
    if (!found) {
      skipped.push({ phone: f.phone, reason: 'Not a registered CheckRada user' });
      continue;
    }
    if (refereeId && found.id === refereeId) {
      skipped.push({ phone: f.phone, reason: 'Referee cannot be a challenger' });
      continue;
    }
    valid.push({
      phone:          f.phone,
      nickname:       f.nickname,
      stakePerPerson: f.stakePerPerson,
      userId:         found.id,
      userName:       found.name,
      userPhone:      found.phone,
    });
  }

  if (!valid.length) {
    return NextResponse.json({
      error:   'No valid friends to challenge.',
      skipped,
    }, { status: 400 });
  }

  // ── Sequential wallet fill ────────────────────────────────────────────────
  const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
  if (!freshUser) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  let remainingReal  = Number(freshUser.balanceKes);
  let remainingBonus = Number(freshUser.bonusBalanceKes);
  let totalMpesa     = 0;
  let totalWallet    = 0;

  const allocations = valid.map(f => {
    const stake     = f.stakePerPerson;
    const realUsed  = Math.min(remainingReal,  stake);
    const bonusUsed = Math.min(remainingBonus, Math.max(0, stake - realUsed));
    const walletUsed   = realUsed + bonusUsed;
    const mpesaNeeded  = Math.max(0, stake - walletUsed);
    remainingReal  -= realUsed;
    remainingBonus -= bonusUsed;
    totalMpesa  += mpesaNeeded;
    totalWallet += walletUsed;
    return { ...f, realUsed, bonusUsed, walletUsed, mpesaNeeded };
  });

  // Generate batchId for multi-challenge batches
  const batchId = valid.length > 1
    ? 'BAT' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    : null;

  // Hoisted for rollback
  let totalRealUsed  = allocations.reduce((s, a) => s + a.realUsed,  0);
  let totalBonusUsed = allocations.reduce((s, a) => s + a.bonusUsed, 0);
  const createdChallenges: any[] = [];

  // ── Pre-generate access codes BEFORE the transaction ─────────────────────
  // generateAccessCode() uses the outer prisma client. Calling it inside the
  // $transaction would try to acquire a second connection from the pool while
  // the transaction already holds the only one (Supabase free tier: limit=1).
  // That causes "Timed out fetching a new connection" → 500 error.
  const preGeneratedCodes: string[] = [];
  for (const alloc of allocations) {
    preGeneratedCodes.push(await generateAccessCode());
  }

  // ── Atomic transaction: deduct wallet + create all challenges ─────────────
  await prisma.$transaction(async (tx: any) => {
    // Deduct total wallet portion
    const updateData: any = {};
    if (totalRealUsed  > 0) updateData.balanceKes      = { decrement: totalRealUsed  };
    if (totalBonusUsed > 0) updateData.bonusBalanceKes = { decrement: totalBonusUsed };
    if (Object.keys(updateData).length > 0) {
      await tx.user.update({ where: { id: user.id }, data: updateData });
    }

    for (let i = 0; i < allocations.length; i++) {
      const alloc      = allocations[i];
      const accessCode = preGeneratedCodes[i];
      const ch = await tx.marketChallenge.create({
        data: {
          question,
          accessCode,
          userAId:          user.id,
          userBId:          alloc.userId || null,   // null = open challenge
          refereeId,
          stakePerPerson:   alloc.stakePerPerson,
          totalPool:        alloc.walletUsed,  // M-Pesa portion added by webhook
          validatorType:    refereeId ? 'REFEREE' : (resolutionType === 'TIMER' ? 'TIMER' : 'MUTUAL'),
          eventExpiresAt:   new Date(eventExpiresAt),
          isPublic,
          status:           alloc.mpesaNeeded > 0 ? 'PENDING_PAYMENT' : 'PENDING_JOIN',
          challengerAAlias: challengerAAlias ? sanitizeText(challengerAAlias) : null,
          challengerBAlias: alloc.nickname ? sanitizeText(alloc.nickname) : null,
          batchId,
        },
      });

      // Two separate txns so cancelPendingPayment can refund each to the correct bucket
      if (alloc.realUsed > 0) {
        await tx.transaction.create({
          data: {
            userId:      user.id,
            challengeId: ch.id,
            type:        'CHALLENGE_STAKE',
            amountKes:   -alloc.realUsed,
            balAfter:    Number(freshUser.balanceKes) - totalRealUsed,
            status:      'SUCCESS',
            description: `Challenge stake (real balance): KES ${alloc.realUsed} for "${question.slice(0, 40)}"`,
          },
        });
      }
      if (alloc.bonusUsed > 0) {
        await tx.transaction.create({
          data: {
            userId:      user.id,
            challengeId: ch.id,
            type:        'BONUS_USED',
            amountKes:   -alloc.bonusUsed,
            balAfter:    Number(freshUser.bonusBalanceKes) - totalBonusUsed,
            status:      'SUCCESS',
            description: `Challenge stake (bonus balance): KES ${alloc.bonusUsed} for "${question.slice(0, 40)}"`,
          },
        });
      }

      createdChallenges.push({ ...ch, friend: alloc });
    }
  }, { timeout: 30000 });

  // ── Single M-Pesa STK push for combined shortfall ────────────────────────
  let stkMessage: string | null = null;

  if (totalMpesa > 0) {
    const ref            = generateReference('CHG');
    const formattedPhone = normalisePhone(freshUser.phone);
    const email          = `${formattedPhone.replace('+', '')}@checkrada.co.ke`;

    try {
      // Link to first challenge; batchId identifies the rest
      const firstChallenge = createdChallenges[0];
      await prisma.transaction.create({
        data: {
          userId:      user.id,
          challengeId: firstChallenge.id,
          type:        'CHALLENGE_STAKE',
          amountKes:   totalMpesa,
          balAfter:    Number(freshUser.balanceKes) - totalRealUsed,
          phone:       formattedPhone,
          mpesaRef:    ref,
          status:      'PENDING',
          description: `Batch challenge M-Pesa: KES ${totalMpesa} for ${valid.length} challenge(s)`,
        },
      });

      const stkResult = await chargeMpesa({
        email,
        amountKes:  totalMpesa,
        phone:      formattedPhone,
        reference:  ref,
        metadata: {
          userId:      user.id,
          challengeId: firstChallenge.id,
          batchId:     batchId || firstChallenge.id,
          platform:    'checkrada',
          paymentType: 'batch_challenge_stake',
        },
      });

      stkMessage = stkResult.display_text || `Check your phone for an M-Pesa prompt — KES ${totalMpesa}.`;

    } catch (stkErr: any) {
      // Rollback: cancel all challenges + refund wallet
      for (const ch of createdChallenges) {
        await prisma.marketChallenge.update({ where: { id: ch.id }, data: { status: 'CANCELLED' } });
      }
      await prisma.user.update({
        where: { id: user.id },
        data: {
          ...(totalRealUsed  > 0 ? { balanceKes:      { increment: totalRealUsed  } } : {}),
          ...(totalBonusUsed > 0 ? { bonusBalanceKes: { increment: totalBonusUsed } } : {}),
        },
      });
      return NextResponse.json({
        error: `Could not initiate M-Pesa payment: ${stkErr.message}. Your wallet has been refunded.`,
      }, { status: 500 });
    }
  }

  // ── Notifications: only for challenges that are already PENDING_JOIN ──────
  const creatorName = displayName(user.name, user.phone);
  for (let i = 0; i < allocations.length; i++) {
    const alloc = allocations[i];
    const ch    = createdChallenges[i];   // created in same order as allocations
    if (!ch) continue;
    if (ch.status !== 'PENDING_JOIN') continue;  // webhook notifies after M-Pesa
    if (!alloc.userId) continue;                 // open challenge — no B to notify yet

    void createNotification({
      userId:  alloc.userId,
      type:    'CHALLENGE_OPPONENT_STAKED',
      title:   "⚡ You've been challenged!",
      message: `${creatorName} challenged you: "${question.slice(0, 60)}". Stake: KES ${alloc.stakePerPerson.toLocaleString()}. Code: ${ch.accessCode}`,
      link:    `/join/${ch.accessCode}`,
      whatsapp: {
        template:   'CHALLENGE_OPPONENT_STAKED',
        parameters: [creatorName, alloc.stakePerPerson.toLocaleString()],
      },
    });

    if (refereeId) {
      void createNotification({
        userId:  refereeId,
        type:    'REFEREE_NOMINATED',
        title:   "⚖️ You've been nominated as referee",
        message: `${creatorName} nominated you to referee "${question.slice(0, 60)}". Code: ${ch.accessCode}`,
        link:    '/rada-friends.html',
        whatsapp: { template: 'REFEREE_NOMINATED', parameters: [creatorName] },
      });
    }
  }

  return NextResponse.json({
    success:   true,
    created:   createdChallenges.map(ch => ({
      id:         ch.id,
      accessCode: ch.accessCode,
      friendPhone: ch.friend?.phone,
      stake:      ch.friend?.stakePerPerson,
      status:     ch.status,
    })),
    skipped,
    batchId,
    stkMessage,
    payment: { totalWallet, totalMpesa },
  });
}
