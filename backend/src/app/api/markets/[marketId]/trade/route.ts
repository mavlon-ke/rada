// src/app/api/markets/[marketId]/trade/route.ts
// Option B fee model: 5% forecasting fee deducted on every trade.
// Creator royalty (admin-tunable, default 0.5%) is carved from the 5% fee — only when
// market totalVolume >= configured threshold (default KES 1,000) AND creator is not a system/admin user.
// Net amount entering AMM = stake - 5% fee (always).
// When royalty applies: platform keeps fee minus royalty; creator gets royalty. Pool unaffected.
// Wallet-first payment: real balance used first, then bonus balance.
//
// Referral programme:
//   - Referee bonus is credited at deposit time (handled in webhook).
//   - Referrer real-money reward is paid HERE on referee's first trade
//     via payReferrerOnFirstTrade(). PENDING -> REWARDED in one transition (Option Y).
//   - Referral business logic lives in @/lib/referrals/referral.service.ts;
//     this route just detects "first trade" and delegates.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { sharesToReceive, newPools } from '@/lib/market/amm';
import { createNotification } from '@/lib/notifications';
import { payReferrerOnFirstTrade, notifyReferrerRewarded } from '@/lib/referrals/referral.service';

const FORECASTING_FEE_RATE      = 0.05;   // 5% total fee — kept as code constant per platform decision
const MAX_CREATOR_ROYALTY_RATE  = 0.05;   // Hard cap: defence-in-depth. Even if DB tampered, never pay >5%.
const DEFAULT_CREATOR_ROYALTY_RATE      = 0.005;
const DEFAULT_CREATOR_ROYALTY_THRESHOLD = 1000;

const TradeSchema = z.object({
  side:           z.enum(['YES', 'NO']),
  amountKes:      z.number().min(20).max(20000),
  bonusAmountKes: z.number().min(0).default(0),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { marketId: string } }
) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json();
  const parsed = TradeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { side, amountKes, bonusAmountKes } = parsed.data;

  // ── Read PlatformConfig once before the transaction. One DB query per trade,
  //    sub-millisecond with the singleton lookup.
  //    Defence-in-depth: clamp royalty rate at hard cap regardless of stored value.
  const platformConfig = await prisma.platformConfig.findUnique({ where: { id: 'singleton' } });
  const creatorRoyaltyRate = Math.min(
    platformConfig ? Number(platformConfig.creatorRoyaltyRate) : DEFAULT_CREATOR_ROYALTY_RATE,
    MAX_CREATOR_ROYALTY_RATE
  );
  const creatorRoyaltyThreshold = platformConfig
    ? Number(platformConfig.creatorRoyaltyThresholdKes)
    : DEFAULT_CREATOR_ROYALTY_THRESHOLD;
  const creatorProgrammeActive = platformConfig ? platformConfig.creatorProgrammeActive : true;

  // ── Fee calculation ───────────────────────────────────────────────────────
  const feeKes    = Math.floor(amountKes * FORECASTING_FEE_RATE);
  const netAmount = amountKes - feeKes;

  // ── Wallet-first payment split ────────────────────────────────────────────
  const clampedBonus  = Math.min(bonusAmountKes, amountKes);
  const realAmountKes = amountKes - clampedBonus;

  const result = await prisma.$transaction(async (tx) => {
    const market = await tx.market.findUnique({ where: { id: params.marketId } });
    if (!market)                      throw new Error('Market not found');
    if (market.status !== 'OPEN')     throw new Error('Market is not open for trading');
    if (new Date() > market.closesAt) throw new Error('Market has closed');

    const freshUser = await tx.user.findUnique({ where: { id: user.id } });
    if (!freshUser) throw new Error('User not found');

    // Validate sufficient balances
    if (Number(freshUser.balanceKes) < realAmountKes) {
      throw new Error(`Insufficient real balance. Need KES ${realAmountKes}, have KES ${Number(freshUser.balanceKes)}`);
    }
    if (clampedBonus > 0 && Number(freshUser.bonusBalanceKes) < clampedBonus) {
      throw new Error('Insufficient bonus balance');
    }

    // ── First-trade detection — required for referrer payout below.
    //    Counted BEFORE this trade's order is created, so a return value of 0 means
    //    "this is the user's first trade." Order count is a fast lookup with the
    //    orders(userId) index already in place.
    const previousOrderCount = await tx.order.count({ where: { userId: user.id } });
    const isFirstTrade = previousOrderCount === 0;

    // AMM calculation
    const yesPool = Number(market.yesPool);
    const noPool  = Number(market.noPool);
    const shares  = sharesToReceive(yesPool, noPool, side, netAmount);
    const pricePerShare = netAmount / shares;
    const { yesPool: newYes, noPool: newNo } = newPools(yesPool, noPool, side, shares);

    // Deduct balances
    const balanceUpdate: any = {};
    if (realAmountKes > 0) balanceUpdate.balanceKes = { decrement: realAmountKes };
    if (clampedBonus > 0)  balanceUpdate.bonusBalanceKes = { decrement: clampedBonus };
    await tx.user.update({ where: { id: user.id }, data: balanceUpdate });

    // Update market pools
    await tx.market.update({
      where: { id: market.id },
      data: {
        yesPool:     newYes,
        noPool:      newNo,
        totalVolume: { increment: netAmount },
      },
    });

    // Order record. creatorAttribution cookie is written for analytics/legacy
    // attribution tracking — kept intact even though current royalty model uses
    // Market.creatorId only.
    const attributionPhone = req.cookies.get(`rada_ref_${market.id}`)?.value ?? null;
    const order = await tx.order.create({
      data: {
        userId:             user.id,
        marketId:           market.id,
        side,
        amountKes,
        netAmountKes:       netAmount,
        forecastingFeeKes:  feeKes,
        bonusUsedKes:       clampedBonus,
        shares,
        pricePerShare,
        status:             'FILLED',
        creatorAttribution: attributionPhone,
      },
    });

    // Upsert position
    const existingPos = await tx.position.findUnique({
      where: { userId_marketId_side: { userId: user.id, marketId: market.id, side } },
    });
    if (existingPos) {
      const totalShares = Number(existingPos.shares) + shares;
      const totalCost   = Number(existingPos.avgPrice) * Number(existingPos.shares) + netAmount;
      await tx.position.update({
        where: { userId_marketId_side: { userId: user.id, marketId: market.id, side } },
        data:  { shares: totalShares, avgPrice: totalCost / totalShares },
      });
    } else {
      await tx.position.create({
        data: { userId: user.id, marketId: market.id, side, shares, avgPrice: pricePerShare },
      });
    }

    // Transaction log
    const newBalance = Number(freshUser.balanceKes) - realAmountKes;
    await tx.transaction.create({
      data: {
        userId:      user.id,
        type:        'TRADE_BUY',
        amountKes:   -amountKes,
        balAfter:    newBalance,
        status:      'SUCCESS',
        description: `Forecast ${side} on "${market.title.slice(0,60)}" — ${shares.toFixed(2)} shares. Fee: KES ${feeKes}${clampedBonus > 0 ? `. Bonus used: KES ${clampedBonus}` : ''}`,
      },
    });

    // ── Creator royalty — admin-tunable rate & threshold from PlatformConfig.
    //    Skipped entirely when:
    //      - creatorProgrammeActive toggle is off, OR
    //      - market has no creator (orphaned), OR
    //      - trader IS the creator (anti-self-dealing), OR
    //      - market's creator is an ADMIN role user (admin-created markets), OR
    //      - market's volume hasn't crossed the threshold yet.
    //    Double-counting fix: when royalty fires, ALSO write a negative
    //    PlatformRevenue row of type CREATOR_ROYALTY_PAID. The resolve flow
    //    sums all forecastingFeeKes as FORECASTING_FEE revenue; without this
    //    offset, the books overstate platform revenue by the royalty amount.
    const updatedMarket = await tx.market.findUnique({
      where:  { id: market.id },
      select: {
        totalVolume: true,
        creatorId:   true,
        creator:     { select: { role: true } },
      },
    });
    const marketVolume = Number(updatedMarket?.totalVolume ?? 0);

    let creatorRoyaltyKes = 0;
    if (
      creatorProgrammeActive &&
      updatedMarket?.creatorId &&
      updatedMarket.creatorId !== user.id &&
      updatedMarket.creator?.role !== 'ADMIN' &&
      marketVolume >= creatorRoyaltyThreshold
    ) {
      creatorRoyaltyKes = Math.floor(netAmount * creatorRoyaltyRate);
      if (creatorRoyaltyKes >= 1) {
        // Credit creator from the fee — carved out of platform's 5% take
        await tx.user.update({
          where: { id: updatedMarket.creatorId },
          data:  { balanceKes: { increment: creatorRoyaltyKes } },
        });
        await tx.creatorBounty.upsert({
          where:  { marketId: market.id },
          update: { tradeVolume: { increment: netAmount }, bountyEarned: { increment: creatorRoyaltyKes } },
          create: {
            marketId:     market.id,
            creatorId:    updatedMarket.creatorId,
            tradeVolume:  netAmount,
            bountyEarned: creatorRoyaltyKes,
            active:       true,
          },
        });
        // Negative PlatformRevenue offset — accounting integrity.
        await tx.platformRevenue.create({
          data: {
            marketId:    market.id,
            type:        'CREATOR_ROYALTY_PAID',
            amountKes:   -creatorRoyaltyKes,
            description: `Creator royalty paid on "${market.title.slice(0,60)}" — offsets the FORECASTING_FEE recorded at resolve.`,
          },
        });
      }
    }

    // ── Referrer reward on referee's first trade — delegated to service.
    //    Service handles config read, status check, payout, and PENDING -> REWARDED.
    let referrerPayout = { paid: 0, referrerId: null as string | null };
    if (isFirstTrade) {
      referrerPayout = await payReferrerOnFirstTrade(tx, user.id);
    }

    return {
      order,
      shares:            parseFloat(shares.toFixed(4)),
      pricePerShare:     parseFloat(pricePerShare.toFixed(4)),
      forecastingFeeKes: feeKes,
      netAmountKes:      netAmount,
      bonusUsedKes:      clampedBonus,
      creatorRoyaltyKes,
      referrerRewardPaid: referrerPayout.paid,
      referrerId:         referrerPayout.referrerId,
      newYesPrice: parseFloat(
        (Math.exp(newYes/1000) / (Math.exp(newYes/1000) + Math.exp(newNo/1000))).toFixed(4)
      ),
    };
  });

  // Notify trader (fire-and-forget)
  createNotification({
    userId:  user.id,
    type:    'MARKET_CLOSING_SOON',
    title:   '✅ Forecast placed',
    message: `Your ${result.order.side} forecast is live. ${result.shares} shares at KES ${result.pricePerShare.toFixed(2)}/share.`,
    link:    '/rada-portfolio.html',
  }).catch(() => {});

  // Notify referrer (fire-and-forget) — only if reward fired this trade
  if (result.referrerRewardPaid > 0 && result.referrerId) {
    notifyReferrerRewarded(result.referrerId, result.referrerRewardPaid).catch(() => {});
  }

  return NextResponse.json({ success: true, ...result });
}
