// src/app/api/admin/proposals/[id]/approve/route.ts
// Approve a user suggestion → create a live Market + credit suggestion reward

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';
import { generateUniqueSlug, buildMarketShareUrl } from '@/lib/market/slug';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const admin = await requireAdmin(req);
    if (!admin) return adminUnauthorized();

    const proposal = await prisma.marketProposal.findUnique({
      where:   { id: params.id },
      include: { proposer: true },
    });

    if (!proposal) {
      return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
    }
    if (proposal.status !== 'PENDING') {
      return NextResponse.json({ error: 'Proposal already processed' }, { status: 400 });
    }

    // Read suggestion reward from PlatformConfig (singleton).
    // Falls back to 50 if the singleton row is missing for any reason.
    const config = await prisma.platformConfig.findUnique({ where: { id: 'singleton' } });
    const rewardKes = config ? Number(config.suggestionRewardKes) : 50;

    // Generate unique slug
    const slug = await generateUniqueSlug(proposal.question);

    // Honor user-suggested closesAt if present and still in the future.
    // Otherwise fall back to default 90 days from approval.
    // Admin retains override capability via the Edit Market panel after approval.
    let closesAt: Date;
    if (proposal.closesAt && proposal.closesAt.getTime() > Date.now()) {
      closesAt = proposal.closesAt;
    } else {
      closesAt = new Date(Date.now() + NINETY_DAYS_MS);
    }

    const { market } = await prisma.$transaction(async (tx) => {
      // 1. Create the live Market
      const market = await tx.market.create({
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

      // 2. Create CreatorBounty so creator royalties accrue from first trade
      await tx.creatorBounty.create({
        data: {
          marketId:  market.id,
          creatorId: proposal.proposerId,
          active:    true,
        },
      });

      // 3. Mark proposal approved
      await tx.marketProposal.update({
        where: { id: proposal.id },
        data:  { status: 'APPROVED', slug, rewardPaidAt: new Date() },
      });

      // 4. Credit suggestion reward to proposer wallet
      const updated = await tx.user.update({
        where: { id: proposal.proposerId },
        data:  { balanceKes: { increment: rewardKes } },
      });

      // 5. Log reward transaction
      await tx.transaction.create({
        data: {
          userId:      proposal.proposerId,
          type:        'SUGGESTION_REWARD',
          amountKes:   rewardKes,
          balAfter:    Number(updated.balanceKes),
          status:      'SUCCESS',
          description: `Market suggestion reward — "${proposal.question.slice(0, 60)}" approved`,
        },
      });

      return { market };
    });

    await logAdminAction(admin.id, 'PROPOSAL_APPROVED', `proposal:${proposal.id}`, {
      question:  proposal.question,
      marketId:  market.id,
      proposer:  proposal.proposer.phone,
      rewardKes,
      closesAt:  closesAt.toISOString(),
      usedSuggestedClosesAt: !!(proposal.closesAt && proposal.closesAt.getTime() > Date.now()),
    }, req);

    return NextResponse.json({
      success:        true,
      proposalId:     proposal.id,
      marketId:       market.id,
      slug,
      shareUrl:       buildMarketShareUrl(slug, proposal.proposer.phone),
      rewardCredited: rewardKes,
      proposerPhone:  proposal.proposer.phone,
      closesAt:       closesAt.toISOString(),
    });

  } catch (err) {
    console.error('[approve proposal]', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
