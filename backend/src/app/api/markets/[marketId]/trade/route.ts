// src/app/api/markets/[marketId]/trade/route.ts
// Option B fee model: 5% forecasting fee deducted on every trade.
// Wallet-first payment: real balance used first, then bonus balance.
// Bonus balance (referral reward) converts to withdrawable real balance when staked.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/session';
import { sharesToReceive, newPools } from '@/lib/market/amm';
import { createNotification } from '@/app/api/notifications/route';

const FORECASTING_FEE_RATE        = 0.05;
const CREATOR_ROYALTY_RATE        = 0.005;
const CREATOR_ROYALTY_THRESHOLD   = 1000;

const TradeSchema = z.object({
  side:      z.enum(['YES', 'NO']),
  amountKes: z.number().min(20).max(20000),
  // paymentSource: used by multi-forecast to indicate source breakdown
  bonusAmountKes: z.number().min(0).default(0),  // how much to draw from bonus balance
});

export async function POST(
  req: NextRequest,
  { params }: { params: { marketId: string } }
) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (user.kycStatus !== 'VERIFIED') {
    return NextResponse.json({ error: 'KYC verification required to trade' }, { status: 403 });
  }

  const body   = await req.json();
  const parsed = TradeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { side, amountKes, bonusAmountKes } = parsed.data;

  // ── Fee calculation ───────────────────────────────────────────────────────
  const feeKes    = Math.floor(amountKes * FORECASTING_FEE_RATE);
  const netAmount = amountKes - feeKes;

  // ── Wallet-first payment split ────────────────────────────────────────────
  // bonusAmountKes: portion drawn from bonus balance (max = user.bonusBalanceKes)
  // realAmountKes:  portion drawn from real balance
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
      throw new Error(`Insufficient bonus balance`);
    }

    // AMM calculation
    const yesPool  = Number(market.yesPool);
    const noPool   = Number(market.noPool);
    const shares   = sharesToReceive(yesPool, noPool, side, netAmount);
    const pricePerShare = netAmount / shares;
    const { yesPool: newYes, noPool: newNo } = newPools(yesPool, noPool, side, shares);

    // Deduct real balance
    const balanceUpdate: any = {};
    if (realAmountKes > 0) {
      balanceUpdate.balanceKes = { decrement: realAmountKes };
    }
    // Deduct bonus balance and convert to real (bonus is "used" when staked)
    if (clampedBonus > 0) {
      balanceUpdate.bonusBalanceKes = { decrement: clampedBonus };
      // Bonus converts to real balance record on use — already deducted, winnings go to real balance
    }
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

    // Order record
    const attributionPhone = req.cookies.get(`rada_ref_${market.id}`)?.value ?? null;
    const order = await tx.order.create({
      data: {
        userId:            user.id,
        marketId:          market.id,
        side,
        amountKes,
        netAmountKes:      netAmount,
        forecastingFeeKes: feeKes,
        bonusUsedKes:      clampedBonus,
        shares,
        pricePerShare,
        status:            'FILLED',
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

    // If bonus was used, mark referral as REWARDED
    if (clampedBonus > 0) {
      await tx.referral.updateMany({
        where:  { refereeId: user.id, status: 'QUALIFIED' },
        data:   { status: 'REWARDED', rewardPaidAt: new Date() },
      });
    }

    // Creator royalty
    const updatedMarket = await tx.market.findUnique({
      where: { id: market.id },
      select: { totalVolume: true, creatorId: true },
    });
    const marketVolume = Number(updatedMarket?.totalVolume ?? 0);
    if (updatedMarket?.creatorId && marketVolume >= CREATOR_ROYALTY_THRESHOLD) {
      const bountyKes = parseFloat((netAmount * CREATOR_ROYALTY_RATE).toFixed(2));
      if (bountyKes >= 0.01) {
        await tx.user.update({
          where: { id: updatedMarket.creatorId },
          data:  { balanceKes: { increment: bountyKes } },
        });
        await tx.creatorBounty.upsert({
          where:  { marketId: market.id },
          update: { tradeVolume: { increment: netAmount }, bountyEarned: { increment: bountyKes } },
          create: { marketId: market.id, creatorId: updatedMarket.creatorId, tradeVolume: netAmount, bountyEarned: bountyKes, active: true },
        });
      }
    }

    return {
      order,
      shares:           parseFloat(shares.toFixed(4)),
      pricePerShare:    parseFloat(pricePerShare.toFixed(4)),
      forecastingFeeKes: feeKes,
      netAmountKes:     netAmount,
      bonusUsedKes:     clampedBonus,
      newYesPrice: parseFloat(
        (Math.exp(newYes/1000) / (Math.exp(newYes/1000) + Math.exp(newNo/1000))).toFixed(4)
      ),
    };
  });

  // Notify user (fire-and-forget, non-blocking)
  createNotification({
    userId:  user.id,
    type:    'MARKET_CLOSING_SOON',
    title:   `✅ Forecast placed`,
    message: `Your ${result.order.side} forecast is live. ${result.shares} shares at KES ${(result.pricePerShare).toFixed(2)}/share.`,
    link:    `/rada-portfolio.html`,
  }).catch(() => {});

  return NextResponse.json({ success: true, ...result });
}
