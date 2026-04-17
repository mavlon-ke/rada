// src/app/api/admin/markets/[marketId]/resolve/route.ts
// Resolves a market and credits winners' CheckRada wallets.
//
// Fee model (Option B): The 5% forecasting fee was already collected at trade time.
// Resolution is therefore FEE-FREE: each winning share redeems for KES 1 in full.
// Exception: unanimous markets still refund everyone in full (unchanged).
//
// Payout model: winnings are credited to the user's CheckRada wallet balance.
// Users withdraw to M-Pesa manually via the standard withdrawal flow.
// This avoids double-payment, eliminates per-resolution Paystack transfer costs,
// and removes dependency on Paystack transfer balance being funded at resolution time.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';

// No fee at resolution — fee was taken at trade time (Option B)
const RESOLUTION_FEE = 0;

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

  // ── Validate market ──────────────────────────────────────────────────────
  const market = await prisma.market.findUnique({
    where: { id: params.marketId },
    include: {
      positions: {
        where: { side: outcome, shares: { gt: 0 } },
        include: { user: true },
      },
    },
  });

  if (!market)                    return NextResponse.json({ error: 'Market not found' }, { status: 404 });
  if (market.status !== 'CLOSED') return NextResponse.json({ error: 'Market must be CLOSED to resolve' }, { status: 400 });
  if (market.outcome)             return NextResponse.json({ error: 'Market already resolved' }, { status: 400 });

  // ── Unanimous consensus check (100/0 split) ──────────────────────────────
  // If nobody is on the losing side, refund everyone in full (no fee)
  const totalYes    = Number(market.yesPool) - 1000;
  const totalNo     = Number(market.noPool)  - 1000;
  const isUnanimous = (outcome === 'YES' && totalNo <= 0) || (outcome === 'NO' && totalYes <= 0);

  // ── Calculate payouts ─────────────────────────────────────────────────────
  // Each winning share redeems at KES 1 in full (fee was already taken at trade).
  // For unanimous markets, all positions are refunded from the full pool.
  const payouts = market.positions.map(p => {
    const netKes = Math.floor(Number(p.shares)); // 1 share = KES 1, no deduction
    return {
      userId:     p.userId,
      phone:      p.user.phone,
      netKes,
      shares:     Number(p.shares),
      positionId: p.id,
    };
  }).filter(p => p.netKes >= 1);

  const totalNet = payouts.reduce((s, p) => s + p.netKes, 0);

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

    // 2. Credit winners' wallet balances and log transactions as SUCCESS
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
          status:      'SUCCESS', // wallet credit is the completed payout
          description: `Market payout (${outcome}) — ${market.title.slice(0, 80)}. Credited to CheckRada wallet. Withdraw to M-Pesa anytime.`,
        },
      });
    }

    // 3. Mark creator bounty as inactive (market resolved — royalties stop)
    await tx.creatorBounty.updateMany({
      where:  { marketId: market.id, active: true },
      data:   { active: false, deactivatedAt: new Date() },
    });
  });

  // No Paystack transfer here — winnings are in the user's CheckRada wallet.
  // Users withdraw to M-Pesa via the standard withdrawal flow at their convenience.

  console.log(`[RESOLVE] Market ${market.id} resolved as ${outcome}. ${payouts.length} winners credited. Total: KES ${totalNet}.`);

  return NextResponse.json({
    success:        true,
    outcome,
    marketId:       market.id,
    isUnanimous,
    feeNote:        'Forecasting fee (5%) collected at trade time. Winnings credited to CheckRada wallets — no M-Pesa transfer fees incurred.',
    winnersCount:   payouts.length,
    totalPayoutKes: totalNet,
  });
}
