// src/app/api/challenges/referee-batch/route.ts
// Referee creates challenges on behalf of pairs of users.
// R pays nothing — A and B each stake independently when they join.
// Up to 100 pairs per submission. Same question + deadline applies to all.
// Resolution type is always REFEREE (R is both creator and judge).
// Notifications are sent blind — A and B do not learn who the other party is.

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { randomInt } from 'crypto';
import { prisma }             from '@/lib/db/prisma';
import { requireAuth }        from '@/lib/auth/session';
import { createNotification } from '@/lib/notifications';
import { displayName }        from '@/lib/user/display-name';
import { sanitizeText }       from '@/lib/security/middleware';
import { darajaPhone } from '@/lib/daraja/daraja.service';


// dbPhone: strips leading + for DB lookups (users stored as 254XXXXXXXXX, not +254XXXXXXXXX).
function dbPhone(phone: string): string {
  return darajaPhone(phone);
}
const MAX_PAIRS = 100;
const MIN_STAKE = 20;
const MAX_STAKE = 20000;

const PairSchema = z.object({
  phoneA:        z.string().min(10).max(15),
  phoneB:        z.string().min(10).max(15),
  stakePerPerson: z.number().min(MIN_STAKE).max(MAX_STAKE),
  nicknameA:     z.string().max(40).optional(),
  nicknameB:     z.string().max(40).optional(),
});

const Schema = z.object({
  question:       z.string().min(10).max(200),
  pairs:          z.array(PairSchema).min(1).max(MAX_PAIRS),
  eventExpiresAt: z.string().datetime(),
  refereeAlias:   z.string().max(40).optional(),
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
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { pairs, eventExpiresAt } = parsed.data;
  const question      = sanitizeText(parsed.data.question);
  const refereeAlias  = parsed.data.refereeAlias
    ? sanitizeText(parsed.data.refereeAlias) : undefined;

  if (new Date(eventExpiresAt) <= new Date()) {
    return NextResponse.json({ error: 'Event expiry must be in the future' }, { status: 400 });
  }

  // ── Pre-flight: validate all pairs ───────────────────────────────────────
  const skipped: Array<{ pair: number; reason: string }> = [];
  const valid: Array<{
    pairIndex:     number;
    stakePerPerson: number;
    nicknameA?:    string;
    nicknameB?:    string;
    userAId:       string;
    userBId:       string;
    userAName:     string | null;
    userBName:     string | null;
    userAPhone:    string;
    userBPhone:    string;
  }> = [];

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const normA = dbPhone(p.phoneA);
    const normB = dbPhone(p.phoneB);
    const normR = dbPhone(user.phone);

    if (normA === normR || normB === normR) {
      skipped.push({ pair: i + 1, reason: 'Referee cannot be a challenger' });
      continue;
    }
    if (normA === normB) {
      skipped.push({ pair: i + 1, reason: 'Challenger A and B cannot be the same person' });
      continue;
    }

    const [foundA, foundB] = await Promise.all([
      prisma.user.findUnique({ where: { phone: normA }, select: { id: true, name: true, phone: true } }),
      prisma.user.findUnique({ where: { phone: normB }, select: { id: true, name: true, phone: true } }),
    ]);

    if (!foundA) { skipped.push({ pair: i + 1, reason: `Challenger A (${p.phoneA}) is not registered` }); continue; }
    if (!foundB) { skipped.push({ pair: i + 1, reason: `Challenger B (${p.phoneB}) is not registered` }); continue; }
    if (foundA.id === foundB.id) { skipped.push({ pair: i + 1, reason: 'A and B resolve to the same account' }); continue; }

    valid.push({
      pairIndex:      i + 1,
      stakePerPerson: p.stakePerPerson,
      nicknameA:      p.nicknameA ? sanitizeText(p.nicknameA) : undefined,
      nicknameB:      p.nicknameB ? sanitizeText(p.nicknameB) : undefined,
      userAId:        foundA.id,
      userBId:        foundB.id,
      userAName:      foundA.name,
      userBName:      foundB.name,
      userAPhone:     foundA.phone,
      userBPhone:     foundB.phone,
    });
  }

  if (!valid.length) {
    return NextResponse.json({ error: 'No valid pairs to create challenges for.', skipped }, { status: 400 });
  }

  const batchId = valid.length > 1
    ? 'RBAT' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    : null;

  const refName = displayName(user.name, user.phone);
  const created: any[] = [];

  // ── Pre-generate access codes BEFORE the transaction ─────────────────────
  // Avoids nested connection pool deadlock (Supabase free tier: connection limit=1).
  const preGeneratedCodes: string[] = [];
  for (const v of valid) {
    preGeneratedCodes.push(await generateAccessCode());
  }

  // ── Create all challenges (no wallet deduction — R pays nothing) ──────────
  await prisma.$transaction(async (tx: any) => {
    for (let i = 0; i < valid.length; i++) {
      const v          = valid[i];
      const accessCode = preGeneratedCodes[i];
      const ch = await tx.marketChallenge.create({
        data: {
          question,
          accessCode,
          userAId:          v.userAId,
          userBId:          v.userBId,
          refereeId:        user.id,
          stakePerPerson:   v.stakePerPerson,
          totalPool:        0,              // R pays nothing; A and B stake when joining
          validatorType:    'REFEREE',      // always — R is both creator and judge
          eventExpiresAt:   new Date(eventExpiresAt),
          isPublic:         false,
          status:           'PENDING_BOTH', // waiting for both to stake
          challengerAAlias: v.nicknameA || null,
          challengerBAlias: v.nicknameB || null,
          batchId,
        },
      });
      created.push({ ...ch, pair: v });
    }
  }, { timeout: 30000 });

  // ── Blind notifications: A and B do not know who the other party is ───────
  for (const ch of created) {
    const v = ch.pair;

    // Notify A — blind: only shows stake amount and referee name
    void createNotification({
      userId:  v.userAId,
      type:    'CHALLENGE_OPPONENT_STAKED',
      title:   '⚖️ You have been challenged!',
      message: `${refName} has set up a challenge for you: "${question.slice(0, 60)}". Stake KES ${v.stakePerPerson.toLocaleString()} to participate. Code: ${ch.accessCode}`,
      link:    `/join/${ch.accessCode}`,
      whatsapp: {
        template:   'CHALLENGE_OPPONENT_STAKED',
        parameters: [refName, v.stakePerPerson.toLocaleString()],
      },
    });

    // Notify B — same blind message, same code
    void createNotification({
      userId:  v.userBId,
      type:    'CHALLENGE_OPPONENT_STAKED',
      title:   '⚖️ You have been challenged!',
      message: `${refName} has set up a challenge for you: "${question.slice(0, 60)}". Stake KES ${v.stakePerPerson.toLocaleString()} to participate. Code: ${ch.accessCode}`,
      link:    `/join/${ch.accessCode}`,
      whatsapp: {
        template:   'CHALLENGE_OPPONENT_STAKED',
        parameters: [refName, v.stakePerPerson.toLocaleString()],
      },
    });
  }

  return NextResponse.json({
    success: true,
    created: created.map(ch => ({
      id:         ch.id,
      accessCode: ch.accessCode,
      pairIndex:  ch.pair.pairIndex,
      stake:      ch.pair.stakePerPerson,
      status:     ch.status,
    })),
    skipped,
    batchId,
    totalPairs: created.length,
  });
}
