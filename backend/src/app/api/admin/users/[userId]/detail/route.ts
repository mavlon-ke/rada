// src/app/api/admin/users/[userId]/detail/route.ts
// Comprehensive user profile endpoint for the admin user audit modal.
// tab=overview|wallet|positions|trades|challenges|suggestions|creator
// Supports date-range filtering (from/to) and pagination (page, limit=100).

import { NextRequest, NextResponse } from 'next/server';
import { prisma }                    from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';

const DEFAULT_CUT_RATE = 0.20;
const LIMIT            = 100;

function dw(from?: string|null, to?: string|null) {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: new Date(from) }                       : {}),
    ...(to   ? { lte: new Date(to + 'T23:59:59.999Z') }     : {}),
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: { userId: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const sp   = new URL(req.url).searchParams;
  const tab  = sp.get('tab') ?? 'overview';
  const from = sp.get('from');
  const to   = sp.get('to');
  const page = Math.max(1, parseInt(sp.get('page') ?? '1') || 1);
  const dateFilter = dw(from, to);
  const { userId } = params;

  try {
    // Lightweight user existence check (reused across tabs)
    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: {
        id: true, phone: true, name: true, kycStatus: true, role: true,
        balanceKes: true, bonusBalanceKes: true, suspended: true,
        agreedToTerms: true, integrityScore: true, whatsappOptedOut: true,
        referralCode: true, referredBy: true, createdAt: true,
      },
    });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    // ── OVERVIEW ─────────────────────────────────────────────────────────────
    if (tab === 'overview') {
      // Referrer (user who referred this user)
      let referrer: { id:string; name:string|null; phone:string } | null = null;
      if (user.referredBy) {
        referrer = await prisma.user.findFirst({
          where:  { referralCode: user.referredBy },
          select: { id: true, name: true, phone: true },
        });
      }

      // Referrals made by this user
      const referrals = await prisma.referral.findMany({
        where:   { referrerId: userId },
        include: { referee: { select: { id: true, name: true, phone: true } } },
        orderBy: { createdAt: 'desc' },
      });

      // All-time lifetime value (total fees platform collected from this user)
      const lifetimeAgg = await prisma.order.aggregate({
        where: { userId },
        _sum:  { forecastingFeeKes: true },
      });
      const lifetimeValue = Number(lifetimeAgg._sum.forecastingFeeKes ?? 0);

      // Date-range stats
      const [orderAgg, depAgg, wdAgg, payoutAgg] = await Promise.all([
        prisma.order.aggregate({
          where: { userId, ...(dateFilter ? { createdAt: dateFilter } : {}) },
          _sum:  { amountKes: true, forecastingFeeKes: true },
          _count: { id: true },
        }),
        prisma.transaction.aggregate({
          where: { userId, type: 'DEPOSIT', status: 'SUCCESS',
                   ...(dateFilter ? { createdAt: dateFilter } : {}) },
          _sum: { amountKes: true }, _count: { id: true },
        }),
        prisma.transaction.aggregate({
          where: { userId, type: 'WITHDRAWAL', status: 'SUCCESS',
                   ...(dateFilter ? { createdAt: dateFilter } : {}) },
          _sum: { amountKes: true }, _count: { id: true },
        }),
        prisma.transaction.aggregate({
          where: { userId, type: 'PAYOUT', status: 'SUCCESS',
                   ...(dateFilter ? { createdAt: dateFilter } : {}) },
          _sum: { amountKes: true },
        }),
      ]);

      // Win/loss from all resolved positions (all-time, not date-filtered)
      const allPositions = await prisma.position.findMany({
        where:   { userId },
        select:  { side: true, market: { select: { status: true, outcome: true } } },
      });
      const wins   = allPositions.filter(p => p.market.status === 'RESOLVED' && p.market.outcome === p.side).length;
      const losses = allPositions.filter(p => p.market.status === 'RESOLVED' && p.market.outcome && p.market.outcome !== p.side).length;
      const winRate = (wins + losses) > 0 ? parseFloat((wins / (wins + losses) * 100).toFixed(1)) : null;

      const totalStaked      = Number(orderAgg._sum.amountKes         ?? 0);
      const totalFeesPaid    = Number(orderAgg._sum.forecastingFeeKes ?? 0);
      const totalDeposits    = Number(depAgg._sum.amountKes           ?? 0);
      const totalWithdrawals = Math.abs(Number(wdAgg._sum.amountKes   ?? 0));
      const totalPayouts     = Number(payoutAgg._sum.amountKes        ?? 0);

      return NextResponse.json({
        user: {
          ...user,
          balanceKes:      Number(user.balanceKes),
          bonusBalanceKes: Number(user.bonusBalanceKes),
        },
        referrer,
        referrals: referrals.map(r => ({
          referee:          r.referee,
          status:           r.status,
          referrerRewardKes: Number(r.referrerRewardKes),
          rewardPaidAt:     r.rewardPaidAt,
          createdAt:        r.createdAt,
        })),
        lifetimeValue,
        summary: {
          totalStaked, totalFeesPaid, totalDeposits, totalWithdrawals,
          totalPayouts,
          netPnl:           totalPayouts - totalStaked,
          tradeCount:       orderAgg._count.id,
          depositCount:     depAgg._count.id,
          withdrawalCount:  wdAgg._count.id,
          wins, losses, winRate,
        },
      });
    }

    // ── WALLET ───────────────────────────────────────────────────────────────
    if (tab === 'wallet') {
      const where = { userId, ...(dateFilter ? { createdAt: dateFilter } : {}) };
      const [transactions, total] = await Promise.all([
        prisma.transaction.findMany({
          where, orderBy: { createdAt: 'desc' },
          skip: (page - 1) * LIMIT, take: LIMIT,
        }),
        prisma.transaction.count({ where }),
      ]);
      return NextResponse.json({
        transactions: transactions.map(t => ({
          id: t.id, type: t.type,
          amountKes: Number(t.amountKes),
          balAfter:  Number(t.balAfter),
          status:    t.status,
          description: t.description,
          createdAt: t.createdAt,
        })),
        total, page, limit: LIMIT,
      });
    }

    // ── POSITIONS ────────────────────────────────────────────────────────────
    if (tab === 'positions') {
      const config  = await prisma.platformConfig.findUnique({ where: { id: 'singleton' } });
      const cutRate = config ? Number(config.resolutionCutRate) : DEFAULT_CUT_RATE;

      const positions = await prisma.position.findMany({
        where:   { userId, shares: { gt: 0 } },
        include: {
          market: {
            select: {
              id: true, title: true, status: true, outcome: true,
              yesPool: true, noPool: true, totalVolume: true,
              category: true, closesAt: true, resolvedAt: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
      });

      // Staked per position — sum orders by marketId + side
      const mIds = Array.from(new Set(positions.map(p => p.marketId)));
      const stakeRows = await prisma.order.groupBy({
        by:    ['marketId', 'side'],
        where: { userId, marketId: { in: mIds } },
        _sum:  { amountKes: true, forecastingFeeKes: true },
      });
      const stakeMap = new Map<string, { gross: number; fees: number }>();
      for (const r of stakeRows) {
        stakeMap.set(`${r.marketId}_${r.side}`, {
          gross: Number(r._sum.amountKes ?? 0),
          fees:  Number(r._sum.forecastingFeeKes ?? 0),
        });
      }

      const enriched = positions.map(p => {
        const key    = `${p.marketId}_${p.side}`;
        const stake  = stakeMap.get(key) ?? { gross: 0, fees: 0 };
        const shares = Number(p.shares);
        const yp = Number(p.market.yesPool), np = Number(p.market.noPool);
        const currentProb = p.side === 'YES' ? yp / (yp + np) : np / (yp + np);
        const isOpen     = ['OPEN', 'PAUSED'].includes(p.market.status);
        const isClosed   = p.market.status === 'CLOSED';
        const isResolved = p.market.status === 'RESOLVED';
        const won        = isResolved && p.market.outcome === p.side;
        const lost       = isResolved && !!p.market.outcome && p.market.outcome !== p.side;

        return {
          marketId:        p.marketId,
          marketTitle:     p.market.title,
          marketStatus:    p.market.status,
          marketOutcome:   p.market.outcome,
          marketCategory:  p.market.category,
          closesAt:        p.market.closesAt,
          resolvedAt:      p.market.resolvedAt,
          side:            p.side,
          shares,
          avgPrice:        Number(p.avgPrice),
          grossStaked:     stake.gross,
          feesPaid:        stake.fees,
          netStaked:       stake.gross - stake.fees,
          currentProb:     parseFloat(currentProb.toFixed(4)),
          estimatedValue:  (isOpen || isClosed)
            ? parseFloat((shares * currentProb * (1 - cutRate)).toFixed(2))
            : null,
          realizedPnl:     Number(p.realizedPnl),
          won, lost, isOpen, isClosed, isResolved,
        };
      });

      return NextResponse.json({
        open:     enriched.filter(p => p.isOpen),
        pending:  enriched.filter(p => p.isClosed),
        resolved: enriched.filter(p => p.isResolved || p.marketStatus === 'CANCELLED'),
        cutRate,
      });
    }

    // ── TRADES ───────────────────────────────────────────────────────────────
    if (tab === 'trades') {
      const where = { userId, ...(dateFilter ? { createdAt: dateFilter } : {}) };
      const [orders, total, sumAgg] = await Promise.all([
        prisma.order.findMany({
          where,
          include: { market: { select: { title: true, status: true, outcome: true, category: true } } },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * LIMIT, take: LIMIT,
        }),
        prisma.order.count({ where }),
        prisma.order.aggregate({
          where,
          _sum: { amountKes: true, forecastingFeeKes: true, netAmountKes: true },
        }),
      ]);
      return NextResponse.json({
        orders: orders.map(o => ({
          id: o.id, marketId: o.marketId,
          marketTitle:    o.market.title,
          marketStatus:   o.market.status,
          marketOutcome:  o.market.outcome,
          marketCategory: o.market.category,
          side:  o.side,
          amountKes:         Number(o.amountKes),
          netAmountKes:      Number(o.netAmountKes),
          forecastingFeeKes: Number(o.forecastingFeeKes),
          shares:            Number(o.shares),
          pricePerShare:     Number(o.pricePerShare),
          status:    o.status,
          createdAt: o.createdAt,
        })),
        summary: {
          totalStaked: Number(sumAgg._sum.amountKes         ?? 0),
          totalFees:   Number(sumAgg._sum.forecastingFeeKes ?? 0),
          totalNet:    Number(sumAgg._sum.netAmountKes      ?? 0),
        },
        total, page, limit: LIMIT,
      });
    }

    // ── CHALLENGES ───────────────────────────────────────────────────────────
    if (tab === 'challenges') {
      const where = {
        OR: [{ userAId: userId }, { userBId: userId }],
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      };
      const [challenges, total] = await Promise.all([
        prisma.marketChallenge.findMany({
          where,
          include: {
            userA: { select: { id: true, name: true, phone: true } },
            userB: { select: { id: true, name: true, phone: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * LIMIT, take: LIMIT,
        }),
        prisma.marketChallenge.count({ where }),
      ]);
      return NextResponse.json({
        challenges: challenges.map(c => {
          const isA    = c.userAId === userId;
          const opp    = isA ? c.userB : c.userA;
          const uConf  = isA ? c.userAConfirm : c.userBConfirm;
          const won    = c.resolution === (isA ? 'USER_A' : 'USER_B');
          const lost   = !!c.resolution && !won && c.resolution !== 'TIE';
          const tied   = c.resolution === 'TIE';
          return {
            id: c.id, question: c.question,
            opponent:       opp ? { name: opp.name, phone: opp.phone } : null,
            isCreator:      isA,
            stakePerPerson: Number(c.stakePerPerson),
            totalPool:      Number(c.totalPool),
            platformFeeKes: Number(c.platformFeeKes),
            feePercent:     Number(c.feePercent),
            status:      c.status,
            resolution:  c.resolution,
            userConfirm: uConf,
            validatorType: c.validatorType,
            won, lost, tied,
            eventExpiresAt: c.eventExpiresAt,
            resolvedAt:     c.resolvedAt,
            createdAt:      c.createdAt,
          };
        }),
        total, page, limit: LIMIT,
      });
    }

    // ── SUGGESTIONS ──────────────────────────────────────────────────────────
    if (tab === 'suggestions') {
      const where = { proposerId: userId, ...(dateFilter ? { createdAt: dateFilter } : {}) };
      const [proposals, total] = await Promise.all([
        prisma.marketProposal.findMany({
          where, orderBy: { createdAt: 'desc' },
          skip: (page - 1) * LIMIT, take: LIMIT,
        }),
        prisma.marketProposal.count({ where }),
      ]);
      return NextResponse.json({
        proposals: proposals.map(p => ({
          id: p.id, question: p.question, category: p.category,
          resolutionSource: p.resolutionSource,
          status:          p.status,
          rejectionReason: p.rejectionReason,
          rewardPaidAt:    p.rewardPaidAt,
          closesAt:        p.closesAt,
          createdAt:       p.createdAt,
        })),
        total, page, limit: LIMIT,
      });
    }

    // ── CREATOR ──────────────────────────────────────────────────────────────
    if (tab === 'creator') {
      const where = { creatorId: userId };
      const [bounties, total, sumAgg] = await Promise.all([
        prisma.creatorBounty.findMany({
          where,
          include: { market: { select: { title: true, status: true, category: true, totalVolume: true, createdAt: true } } },
          orderBy: { bountyEarned: 'desc' },
          skip: (page - 1) * LIMIT, take: LIMIT,
        }),
        prisma.creatorBounty.count({ where }),
        prisma.creatorBounty.aggregate({
          where,
          _sum: { bountyEarned: true, paidOut: true, tradeVolume: true },
        }),
      ]);
      return NextResponse.json({
        bounties: bounties.map(b => ({
          id: b.id,
          marketTitle:    b.market.title,
          marketStatus:   b.market.status,
          marketCategory: b.market.category,
          totalVolume:    Number(b.market.totalVolume),
          tradeVolume:    Number(b.tradeVolume),
          bountyEarned:   Number(b.bountyEarned),
          paidOut:        Number(b.paidOut),
          unpaid:         Number(b.bountyEarned) - Number(b.paidOut),
          active:         b.active,
          lastPaidAt:     b.lastPaidAt,
          marketCreatedAt: b.market.createdAt,
        })),
        summary: {
          totalEarned:  Number(sumAgg._sum.bountyEarned  ?? 0),
          totalPaidOut: Number(sumAgg._sum.paidOut       ?? 0),
          totalUnpaid:  Number(sumAgg._sum.bountyEarned  ?? 0) - Number(sumAgg._sum.paidOut ?? 0),
          totalVolume:  Number(sumAgg._sum.tradeVolume   ?? 0),
        },
        total, page, limit: LIMIT,
      });
    }

    return NextResponse.json({ error: 'Invalid tab' }, { status: 400 });

  } catch (err: any) {
    console.error('[admin/users/detail] error:', err?.message ?? err);
    return NextResponse.json({ error: 'Failed to load user detail', detail: err?.message }, { status: 500 });
  }
}
