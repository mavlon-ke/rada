// src/app/api/admin/user-activity/route.ts
// GET /api/admin/user-activity — recent user platform events for the activity feed

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 200);

  // Fetch recent transactions (deposits, withdrawals, trades, payouts)
  const [txns, recentKyc] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        type: { in: ['DEPOSIT', 'WITHDRAWAL', 'TRADE_BUY', 'TRADE_SELL', 'PAYOUT', 'CHALLENGE_PAYOUT', 'REFUND'] },
        status: { in: ['SUCCESS', 'PENDING'] },
      },
      include: { user: { select: { name: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.user.findMany({
      where:   { kycStatus: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take:    10,
      select:  { name: true, phone: true, createdAt: true },
    }),
  ]);

  // Build unified activity items
  const activities: Array<{
    type: string;
    icon: string;
    color: string;
    text: string;
    createdAt: Date;
  }> = [];

  for (const t of txns) {
    const user   = t.user?.name || (t.user?.phone ? t.user.phone : 'A user');
    const amount = 'KES ' + Number(t.amountKes).toLocaleString();
    let icon = '⚡'; let color = 'ai-blue'; let text = '';

    if (t.type === 'DEPOSIT') {
      icon = '💰'; color = 'ai-green';
      text = `<strong>${user}</strong> deposited <strong>${amount}</strong> via M-Pesa`;
    } else if (t.type === 'WITHDRAWAL') {
      icon = '📤'; color = 'ai-red';
      text = `<strong>${user}</strong> withdrew <strong>${amount}</strong> via M-Pesa`;
    } else if (t.type === 'TRADE_BUY') {
      icon = '🔄'; color = 'ai-blue';
      text = `<strong>${user}</strong> bought shares — <strong>${amount}</strong>`;
    } else if (t.type === 'TRADE_SELL') {
      icon = '🔄'; color = 'ai-blue';
      text = `<strong>${user}</strong> sold shares — <strong>${amount}</strong>`;
    } else if (t.type === 'PAYOUT' || t.type === 'CHALLENGE_PAYOUT') {
      icon = '✓'; color = 'ai-green';
      text = `<strong>${user}</strong> received payout <strong>${amount}</strong>`;
    } else if (t.type === 'REFUND') {
      icon = '↩'; color = 'ai-amber';
      text = `<strong>${user}</strong> refunded <strong>${amount}</strong>`;
    }

    if (text) activities.push({ type: t.type, icon, color, text, createdAt: t.createdAt });
  }

  for (const u of recentKyc) {
    const name  = u.name || 'User';
    const phone = u.phone ? '(+' + u.phone.slice(0, 7) + '***)' : '';
    activities.push({
      type: 'KYC_SUBMISSION',
      icon: '◈', color: 'ai-amber',
      text: `New KYC submission from <strong>${name}</strong> ${phone}`,
      createdAt: u.createdAt,
    });
  }

  // Sort merged list by date descending
  activities.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return NextResponse.json({ activities: activities.slice(0, limit) });
}
