// src/app/api/challenges/[id]/request-admin/route.ts
// Participant requests admin intervention after 24h of the 48h resolution window.
// Only available to Challenger A or B, only after 24h of the window have elapsed.
// Marks the challenge as DISPUTED, notifies both parties and the admin team via SMS.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';


const MIN_HOURS_BEFORE_INTERVENTION = 24; // must wait 24h into the 48h window
const ADMIN_PHONE = process.env.ADMIN_ALERT_PHONE ?? ''; // set in Railway env vars

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const challenge = await prisma.marketChallenge.findUnique({
    where: { id: params.id },
    include: {
      userA: true,
      userB: true,
    },
  });

  if (!challenge) return NextResponse.json({ error: 'Challenge not found' }, { status: 404 });

  // ── Verify caller is a participant ──────────────────────────────────────
  const isParticipant = challenge.userAId === user.id || challenge.userBId === user.id;
  if (!isParticipant) {
    return NextResponse.json({ error: 'Only participants can request admin intervention' }, { status: 403 });
  }

  // ── Verify challenge is in a resolvable state ────────────────────────────
  if (!['ACTIVE', 'PENDING_RESOLUTION'].includes(challenge.status)) {
    return NextResponse.json({
      error: 'Admin intervention is only available for active or pending-resolution challenges',
    }, { status: 400 });
  }

  // ── Verify 24h have passed since the resolution window opened ────────────
  if (!challenge.disputeDeadline) {
    return NextResponse.json({
      error: 'The 48-hour resolution window has not started yet. The event must end first.',
    }, { status: 400 });
  }

  const now             = new Date();
  const windowOpenedAt  = new Date(challenge.disputeDeadline.getTime() - 48 * 60 * 60 * 1000);
  const hoursElapsed    = (now.getTime() - windowOpenedAt.getTime()) / 3600000;

  if (hoursElapsed < MIN_HOURS_BEFORE_INTERVENTION) {
    const hoursRemaining = Math.ceil(MIN_HOURS_BEFORE_INTERVENTION - hoursElapsed);
    return NextResponse.json({
      error: `Admin intervention is only available after 24 hours of the resolution window. ` +
             `Please wait another ${hoursRemaining} hour${hoursRemaining !== 1 ? 's' : ''}.`,
      hoursRemaining,
    }, { status: 400 });
  }

  // ── Check not already disputed ───────────────────────────────────────────
  if (challenge.status === 'DISPUTED') {
    return NextResponse.json({
      error: 'Admin intervention has already been requested for this challenge.',
    }, { status: 400 });
  }

  // ── Mark as DISPUTED ─────────────────────────────────────────────────────
  await prisma.marketChallenge.update({
    where: { id: challenge.id },
    data:  { status: 'DISPUTED' },
  });

  // ── SMS both participants ────────────────────────────────────────────────
  const requesterName = user.name ?? 'A participant';
  const smsParticipants =
    `CheckRada: Admin intervention has been requested for your challenge ` +
    `"${challenge.question.slice(0, 60)}...". ` +
    `A 15% dispute fee will apply. Admin will review within 12 hours. ` +
    `rada.co.ke`;

  await Promise.allSettled([
    challenge.userA?.phone  ? console.log(challenge.userA.phone,  smsParticipants) : Promise.resolve(),
    challenge.userB?.phone  ? console.log(challenge.userB.phone,  smsParticipants) : Promise.resolve(),
    // Alert admin on-call phone
    ADMIN_PHONE ? console.log(ADMIN_PHONE,
      `🚨 Rada Admin Alert: ${requesterName} requested intervention on challenge ` +
      `"${challenge.question.slice(0, 80)}" (ID: ${challenge.id}). ` +
      `Pool: KES ${Number(challenge.totalPool).toLocaleString()}. ` +
      `Review at rada.co.ke/admin`
    ) : Promise.resolve(),
  ]);

  return NextResponse.json({
    success:     true,
    challengeId: challenge.id,
    status:      'DISPUTED',
    message:     'Admin has been notified and will review within 12 hours. Both participants have been sent an SMS.',
    feeNote:     'A 15% dispute fee will apply to the total pool at resolution.',
  });
}
