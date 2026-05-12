// src/app/api/admin/markets/[marketId]/resolve/route.ts
// Resolves a market, credits winners' wallets, and records platform revenue.
//
// Fee model (Option B): 5% forecasting fee collected at trade time.
// Resolution is fee-free: each winning share redeems for KES 1 in full.
// Platform revenue = forecasting fees collected + market surplus (losers' residual).
// DEFAULT_B seed (KES 1000) is virtual and excluded from revenue calculations.
//
// Notifications (added in Stage 2):
// After the transaction commits, fire-and-forget notifications are created
// for every winner and every loser. Notifications are deliberately created
// OUTSIDE the transaction — they aren't critical state and a failure to
// notify must not block the financial side of resolution.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';
import { createNotification } from '@/lib/notifications';

const DEFAULT_B = 1000; // Virtual LMSR seed — excluded from revenue

const Schema = z.object({
  outcome:    z.enum(['YES', 'NO']),
  sourceNote: z.string().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { marketId: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const body   = await req.json();
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { outcome, sourceNote } = parsed.data;
  const losingSide = outcome === 'YES' ? 'NO' : 'YES';

  // ── Validate market AND fetch both winner + loser positions ───────────────
  // The original query fetched only the winning side. We now also fetch the
  // losing side so we can notify those users that the market resolved against
  // their position.
  const market = await prisma.market.findUnique({
    where: { id: params.marketId },
    include: {
      positions: {
        where: { shares: { gt: 0 } },          // both sides
        include: { user: { select: { id: true, phone: true } } },
      },
    },
  });

  if (!market)                    return NextResponse.json({ error: 'Market not found' }, { status: 404 });
  if (market.status !== 'CLOSED') return NextResponse.json({ error: 'Market must be CLOSED to resolve' }, { status: 400 });
  if (market.outcome)             return NextResponse.json({ error: 'Market already resolved' }, { status: 400 });

  // ── Unanimous consensus check ────────────────────────────────────────────
  const totalYes    = Number(market.yesPool) - DEFAULT_B;
  const totalNo     = Number(market.noPool)  - DEFAULT_B;
  const isUnanimous = (outcome === 'YES' && totalNo <= 0) || (outcome === 'NO' && totalYes <= 0);

  // ── Split positions into winners and losers ──────────────────────────────
  const winningPositions = market.positions.filter(p => p.side === outcome);
  const losingPositions  = market.positions.filter(p => p.side === losingSide);

  // ── Calculate winner payouts ──────────────────────────────────────────────
  const payouts = winningPositions.map(p => {
    const netKes = Math.floor(Number(p.shares));
    return {
      userId:     p.userId,
      netKes,
      shares:     Number(p.shares),
      positionId: p.id,
    };
  }).filter(p => p.netKes >= 1);

  const totalPayouts = payouts.reduce((s, p) => s + p.netKes, 0);

  // ── Calculate platform revenue ────────────────────────────────────────────
  // 1. Forecasting fees: sum of forecastingFeeKes from all orders on this market
  const ordersAgg = await prisma.order.aggregate({
    where:  { marketId: market.id },
    _sum:   { forecastingFeeKes: true },
  });
  const totalFeesCollected = Math.floor(Number(ordersAgg._sum.forecastingFeeKes ?? 0));

  // 2. Pool balance: yesPool + noPool minus the virtual seed (DEFAULT_B each side)
  const realPoolBalance = Number(market.yesPool) + Number(market.noPool) - (DEFAULT_B * 2);

  // 3. Market surplus: real pool minus winner payouts minus fees already counted
  const marketSurplus = Math.max(0, realPoolBalance - totalPayouts - totalFeesCollected);

  // ── Atomic DB resolution ──────────────────────────────────────────────────
  await prisma.$transaction(async (tx) => {
    // 1. Mark market resolved
    await tx.market.update({
      where: { id: market.id },
      data: {
        status:     'RESOLVED',
        outcome,
        resolvedAt: new Date(),
        ...(sourceNote ? { sourceNote } : {}),
      },
    });

    // 2. Credit winners' wallets
    for (const p of payouts) {
      const updatedUser = await tx.user.update({
        where: { id: p.userId },
        data:  { balanceKes: { increment: p.netKes } },
      });
      await tx.transaction.create({
        data: {
          userId:      p.userId,
          type:        'PAYOUT',
          amountKes:   p.netKes,
          balAfter:    Number(updatedUser.balanceKes),
          status:      'SUCCESS',
          description: `Market payout (${outcome}) — ${market.title.slice(0, 80)}. Credited to CheckRada wallet.`,
        },
      });
    }

    // 3. Record platform revenue — forecasting fees
    if (totalFeesCollected > 0) {
      await tx.platformRevenue.create({
        data: {
          marketId:    market.id,
          type:        'FORECASTING_FEE',
          amountKes:   totalFeesCollected,
          description: `Forecasting fees (5%) from ${market.title.slice(0, 80)}. ${payouts.length} winner(s), total stakes recovered.`,
        },
      });
    }

    // 4. Record platform revenue — market surplus (losers' residual)
    if (marketSurplus > 0) {
      await tx.platformRevenue.create({
        data: {
          marketId:    market.id,
          type:        'MARKET_SURPLUS',
          amountKes:   marketSurplus,
          description: `Market surplus from losers' stakes — ${market.title.slice(0, 80)}. Pool residual after winner payouts.`,
        },
      });
    }

    // 5. Deactivate creator bounty
    await tx.creatorBounty.updateMany({
      where: { marketId: market.id, active: true },
      data:  { active: false, deactivatedAt: new Date() },
    });
  });

  const totalRevenue = totalFeesCollected + marketSurplus;
  console.log(`[RESOLVE] Market ${market.id} resolved as ${outcome}. Winners: ${payouts.length}, Payouts: KES ${totalPayouts}, Fees: KES ${totalFeesCollected}, Surplus: KES ${marketSurplus}, Total Revenue: KES ${totalRevenue}.`);

  // ── Post-transaction: create notifications (fire-and-forget) ──────────────
  // These run AFTER the financial transaction has committed. If any
  // individual notification creation fails, the resolution itself is not
  // rolled back — the user can still see the outcome via the market page.
  //
  // WhatsApp mirror is included; createNotification calls sendWhatsAppNotification
  // internally, which is itself fail-closed (logs but never throws).
  //
  // Use a short title slice in the param payloads so they fit within Meta's
  // template body limits (a body parameter caps around 1024 chars; market
  // titles are typically <100 but we trim defensively).
  const titleShort = market.title.length > 80 ? market.title.slice(0, 77) + '...' : market.title;
  const outcomeLabel = outcome === 'YES' ? 'YES' : 'NO';

  // Winner notifications
  for (const p of payouts) {
    void createNotification({
      userId:  p.userId,
      type:    'MARKET_RESOLVED',
      title:   `🎉 You won KES ${p.netKes.toLocaleString()}`,
      message: `Market resolved ${outcomeLabel}: "${titleShort}". Your winnings have been credited to your CheckRada wallet.`,
      link:    '/rada-portfolio.html',
      whatsapp: {
        template:   'MARKET_RESOLVED_WON',
        parameters: [p.netKes.toLocaleString(), titleShort],
      },
    });
  }

  // Loser notifications — only for users with shares > 0 on the losing side
  for (const p of losingPositions) {
    void createNotification({
      userId:  p.userId,
      type:    'MARKET_RESOLVED',
      title:   `Market resolved ${outcomeLabel}`,
      message: `"${titleShort}" resolved ${outcomeLabel}. Your shares did not win this time.`,
      link:    '/rada-portfolio.html',
      whatsapp: {
        template:   'MARKET_RESOLVED_LOST',
        parameters: [titleShort, outcomeLabel],
      },
    });
  }

  return NextResponse.json({
    success:            true,
    outcome,
    marketId:           market.id,
    isUnanimous,
    winnersCount:       payouts.length,
    losersCount:        losingPositions.length,
    totalPayoutKes:     totalPayouts,
    platformRevenue: {
      forecastingFees: totalFeesCollected,
      marketSurplus,
      total:           totalRevenue,
    },
    note: 'Winnings credited to CheckRada wallets. Platform revenue recorded separately. Notifications dispatched.',
  });
}
