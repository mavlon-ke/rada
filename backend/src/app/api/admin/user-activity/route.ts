// src/app/api/admin/user-activity/route.ts
// GET /api/admin/user-activity
//
// Params:
//   tab    = all|deposits|withdrawals|trades|payouts|challenges|rewards|users (default: all)
//   page   = page number (default: 1)
//   limit  = items per page (default: 100, max: 100)
//   from   = YYYY-MM-DD  (EAT — interpreted as 00:00 EAT)
//   to     = YYYY-MM-DD  (EAT — interpreted as 23:59:59.999 EAT)
//
// Response: { activities|users, total, page, limit, summary }

import { NextRequest, NextResponse } from 'next/server';
import { prisma }                    from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';
import { withErrorHandling } from '@/lib/security/route-guard';

export const dynamic = 'force-dynamic';

// EAT = UTC+3. Convert a YYYY-MM-DD string in EAT to a UTC Date.
function eatToUtc(dateStr: string, endOfDay = false): Date {
  const time = endOfDay ? 'T23:59:59.999+03:00' : 'T00:00:00.000+03:00';
  return new Date(dateStr + time);
}

// Transaction types per tab
const TAB_TYPES: Record<string, string[]> = {
  all:         ['DEPOSIT','WITHDRAWAL','TRADE_BUY','TRADE_SELL','PAYOUT',
                 'CHALLENGE_PAYOUT','REFUND','CHALLENGE_STAKE',
                 'SUGGESTION_REWARD','CREATOR_BOUNTY','REFERRAL_REWARD','BONUS_USED'],
  deposits:    ['DEPOSIT'],
  withdrawals: ['WITHDRAWAL'],
  trades:      ['TRADE_BUY','TRADE_SELL'],
  payouts:     ['PAYOUT','CHALLENGE_PAYOUT','REFUND'],
  challenges:  ['CHALLENGE_STAKE','CHALLENGE_PAYOUT'],
  rewards:     ['SUGGESTION_REWARD','CREATOR_BOUNTY','REFERRAL_REWARD','BONUS_USED'],
};

// Human-readable label per type
function activityText(type: string, userName: string, amountKes: number): string {
  const user   = `<strong>${userName}</strong>`;
  const amount = `<strong>KES ${Math.abs(amountKes).toLocaleString()}</strong>`;
  switch (type) {
    case 'DEPOSIT':          return `${user} deposited ${amount} via M-Pesa`;
    case 'WITHDRAWAL':       return `${user} withdrew ${amount} via M-Pesa`;
    case 'TRADE_BUY':        return `${user} staked ${amount} on a market`;
    case 'TRADE_SELL':       return `${user} sold shares — ${amount}`;
    case 'PAYOUT':           return `${user} received payout ${amount}`;
    case 'CHALLENGE_PAYOUT': return `${user} received challenge payout ${amount}`;
    case 'CHALLENGE_STAKE':  return `${user} staked ${amount} in a challenge`;
    case 'REFUND':           return amountKes < 0
      ? `${user} payout reversed — ${amount} clawed back`
      : `${user} refunded ${amount}`;
    case 'SUGGESTION_REWARD': return `${user} earned suggestion reward ${amount}`;
    case 'CREATOR_BOUNTY':    return `${user} earned creator bounty ${amount}`;
    case 'REFERRAL_REWARD':   return `${user} earned referral reward ${amount}`;
    case 'BONUS_USED':        return `${user} used bonus balance — ${amount}`;
    default:                  return `${user} — ${type} ${amount}`;
  }
}

function activityIcon(type: string): string {
  const icons: Record<string, string> = {
    DEPOSIT: '💰', WITHDRAWAL: '📤', TRADE_BUY: '🔄', TRADE_SELL: '🔄',
    PAYOUT: '✓', CHALLENGE_PAYOUT: '🏆', CHALLENGE_STAKE: '⚔',
    REFUND: '↩', SUGGESTION_REWARD: '💡', CREATOR_BOUNTY: '🏅',
    REFERRAL_REWARD: '🎁', BONUS_USED: '⭐',
  };
  return icons[type] || '⚡';
}

function activityColor(type: string): string {
  const colors: Record<string, string> = {
    DEPOSIT: 'ai-green', PAYOUT: 'ai-green', CHALLENGE_PAYOUT: 'ai-green',
    SUGGESTION_REWARD: 'ai-green', CREATOR_BOUNTY: 'ai-green', REFERRAL_REWARD: 'ai-green',
    WITHDRAWAL: 'ai-red',
    TRADE_BUY: 'ai-blue', TRADE_SELL: 'ai-blue', CHALLENGE_STAKE: 'ai-blue',
    REFUND: 'ai-amber', BONUS_USED: 'ai-amber',
  };
  return colors[type] || 'ai-blue';
}

export const GET = withErrorHandling(async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  try {
    const sp    = new URL(req.url).searchParams;
    const tab   = sp.get('tab')   ?? 'all';
    const page  = Math.max(1, parseInt(sp.get('page')  ?? '1') || 1);
    const limit = Math.min(100, parseInt(sp.get('limit') ?? '100') || 100);
    const from  = sp.get('from');
    const to    = sp.get('to');
    const skip  = (page - 1) * limit;

    const dateFilter = from || to ? {
      ...(from ? { gte: eatToUtc(from, false) } : {}),
      ...(to   ? { lte: eatToUtc(to,   true)  } : {}),
    } : undefined;

    // ── USERS TAB ──────────────────────────────────────────────────────────
    if (tab === 'users') {
      const where = dateFilter ? { createdAt: dateFilter } : {};
      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where,
          select: { id: true, name: true, phone: true, kycStatus: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.user.count({ where }),
      ]);

      return NextResponse.json({
        users: users.map(u => ({
          id:        u.id,
          name:      u.name || 'User',
          phone:     u.phone,
          kycStatus: u.kycStatus,
          createdAt: u.createdAt,
        })),
        total,
        page,
        limit,
        summary: { count: total },
      });
    }

    // ── TRANSACTION TABS ────────────────────────────────────────────────────
    const types = TAB_TYPES[tab] ?? TAB_TYPES.all;
    const where = {
      type:   { in: types as any[] },
      status: { in: ['SUCCESS', 'PENDING'] as any[] },
      ...(dateFilter ? { createdAt: dateFilter } : {}),
    };

    const [txns, total, volumeAgg] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: { user: { select: { name: true, phone: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.transaction.count({ where }),
      // Volume sum for deposit/withdrawal/trade tabs (meaningful total)
      prisma.transaction.aggregate({
        where,
        _sum: { amountKes: true },
      }),
    ]);

    const activities = txns.map(t => {
      const userName = t.user?.name || (t.user?.phone ? t.user.phone : 'User');
      const amount   = Number(t.amountKes);
      return {
        id:        t.id,
        type:      t.type,
        icon:      activityIcon(t.type),
        color:     activityColor(t.type),
        text:      activityText(t.type, userName, amount),
        amountKes: amount,
        status:    t.status,
        createdAt: t.createdAt,
      };
    });

    return NextResponse.json({
      activities,
      total,
      page,
      limit,
      summary: {
        count:     total,
        volumeKes: Math.round(Math.abs(Number(volumeAgg._sum.amountKes ?? 0))),
      },
    });

  } catch (err: any) {
    console.error('[admin/user-activity] error:', err?.message ?? err);
    return NextResponse.json({ error: 'Failed to load activity' }, { status: 500 });
  }
});
