import { withErrorHandling } from '@/lib/security/route-guard';
// src/app/api/admin/proposals/[id]/approve/route.ts
// Approve a user suggestion → create a live Market + credit suggestion reward (dynamic from ReferralConfig)

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';
import { generateUniqueSlug, buildMarketShareUrl } from '@/lib/market/slug';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const proposal = await prisma.marketProposal.findUnique({
    where:   { id: params.id },
    include: { proposer: true },
  });

  if (!proposal)                     return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
  if (proposal.status !== 'PENDING') return NextResponse.json({ error: 'Proposal already processed' }, { status: 400 });

  // ── Read suggestion reward dynamically from ReferralConfig ──────────────
  const config = await prisma.referralConfig.findUnique({ where: { id: 'singleton' } });
  const SUGGESTION_REWARD_KES = config ? Number(config.referrerRewardKes) : 50;

  // Generate unique slug
  const slug = await generateUniqueSlug(proposal.question);

  // Default closesAt: 90 days from now — admin can edit afterwards
  const closesAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

  let market: any;

  await prisma.$transaction(async (tx) => {
    // 1. Create the live Market
    market = await tx.market.create({
      data: {
        slug,
        title:       proposal.question,
        description: proposal.whyCareNote || proposal.resolutionSource,
        category:    proposal.category,
        sourceNote:  proposal.resolutionSource,
        creatorId:   proposal.proposerId,
        closesAt,
        status:      'OPEN',
      },
    });

    // 2. Create CreatorBounty so royalties accrue from first trade
    await tx.creatorBounty.create({
      data: {
        marketId:  market.id,
        creatorId: proposal.proposerId,
        active:    true,
      },
    });

    // 3. Mark proposal approved and link slug
    await tx.marketProposal.update({
      where: { id: proposal.id },
      data:  { status: 'APPROVED', slug, rewardPaidAt: new Date() },
    });

    // 4. Credit suggestion reward to proposer's wallet
    const updated = await tx.user.update({
      where: { id: proposal.proposerId },
      data:  { balanceKes: { increment: SUGGESTION_REWARD_KES } },
    });

    // 5. Log reward transaction
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
    question:   proposal.question,
    marketId:   market.id,
    proposer:   proposal.proposer.phone,
    rewardKes:  SUGGESTION_REWARD_KES,
  }, req);

  return NextResponse.json({
    success:        true,
    proposalId:     proposal.id,
    marketId:       market.id,
    slug,
    shareUrl:       buildMarketShareUrl(slug, proposal.proposer.phone),
    rewardCredited: SUGGESTION_REWARD_KES,
    proposerPhone:  proposal.proposer.phone,
  });
}
