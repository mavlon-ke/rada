import { withErrorHandling } from '@/lib/security/route-guard';
// src/app/api/admin/proposals/[id]/approve/route.ts
// Approve a user suggestion → auto-credit KES 50 reward to proposer's wallet

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';
import { generateUniqueSlug, buildMarketShareUrl } from '@/lib/market/slug';

const SUGGESTION_REWARD_KES = 50;

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const proposal = await prisma.marketProposal.findUnique({
    where: { id: params.id },
    include: { proposer: true },
  });

  if (!proposal)                    return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
  if (proposal.status !== 'PENDING') return NextResponse.json({ error: 'Proposal already processed' }, { status: 400 });

  // Generate unique slug via shared utility (same format as live markets)
  const slug = await generateUniqueSlug(proposal.question);

  await prisma.$transaction(async (tx) => {
    // 1. Mark proposal approved
    await tx.marketProposal.update({
      where: { id: proposal.id },
      data:  { status: 'APPROVED', slug, rewardPaidAt: new Date() },
    });

    // 2. Credit reward to proposer's wallet
    const updated = await tx.user.update({
      where: { id: proposal.proposerId },
      data:  { balanceKes: { increment: SUGGESTION_REWARD_KES } },
    });

    // 3. Log reward transaction
    await tx.transaction.create({
      data: {
        userId:      proposal.proposerId,
        type:        'SUGGESTION_REWARD',
        amountKes:   SUGGESTION_REWARD_KES,
        balAfter:    Number(updated.balanceKes),
        status:      'SUCCESS',
        description: `Market suggestion reward — "${proposal.question.slice(0, 60)}" approved`,
      },
    });
  });

  await logAdminAction(admin.id, 'PROPOSAL_APPROVED', `proposal:${proposal.id}`, {
    question: proposal.question,
    proposer: proposal.proposer.phone,
    rewardKes: SUGGESTION_REWARD_KES,
  }, req);

  return NextResponse.json({
    success:         true,
    proposalId:      proposal.id,
    slug,
    shareUrl:        buildMarketShareUrl(slug, proposal.proposer.phone),
    rewardCredited:  SUGGESTION_REWARD_KES,
    proposerPhone:   proposal.proposer.phone,
  });
}
