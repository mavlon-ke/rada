// src/app/api/admin/stats/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const now   = new Date();
  const week  = new Date(now.getTime() - 7  * 86400000);
  const today = new Date(now.getTime() - 1  * 86400000);
  const month = new Date(now.getTime() - 30 * 86400000);

  const [
    totalVolume, weekVolume, totalUsers, todayUsers,
    openMarkets, pendingKYC, pendingResolution,
    depositTotal, depositOk, failedPayouts,
    verifiedUsers, marketsWithActivity, totalMarkets,
    referralTotal, referralPaidOut, referralPending,
  ] = await Promise.all([
    prisma.transaction.aggregate({ where: { type: 'TRADE_BUY', status: 'SUCCESS' }, _sum: { amountKes: true } }),
    prisma.transaction.aggregate({ where: { type: 'TRADE_BUY', status: 'SUCCESS', createdAt: { gte: week } }, _sum: { amountKes: true } }),
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: today } } }),
    prisma.market.count({ where: { status: 'OPEN' } }),
    prisma.user.count({ where: { kycStatus: 'PENDING' } }),
    prisma.market.count({ where: { status: 'CLOSED', outcome: null } }),
    prisma.transaction.count({ where: { type: 'DEPOSIT', createdAt: { gte: month } } }),
    prisma.transaction.count({ where: { type: 'DEPOSIT', status: 'SUCCESS', createdAt: { gte: month } } }),
    prisma.transaction.count({ where: { type: 'PAYOUT', status: 'FAILED' } }),
    // KYC completion
    prisma.user.count({ where: { kycStatus: 'VERIFIED' } }),
    // Markets with at least one trade
    prisma.market.count({ where: { orderstatus: { gt: 0 } } }),
    // Total markets
    prisma.market.count(),
    // Referral stats
    prisma.referral.count(),
    prisma.referral.aggregate({ where: { status: 'REWARDED' }, _sum: { referrerRewardKes: true, refereeRewardKes: true } }),
    prisma.referral.count({ where: { status: 'PENDING' } }),
  ]);

  const referralTotalPaidKes =
    Number(referralPaidOut._sum.referrerRewardKes ?? 0) +
    Number(referralPaidOut._sum.refereeRewardKes  ?? 0);

  return NextResponse.json({
    totalVolume:        Math.abs(Number(totalVolume._sum.amountKes ?? 0)),
    weekVolume:         Math.abs(Number(weekVolume._sum.amountKes  ?? 0)),
    totalUsers,
    todayUsers,
    openMarkets,
    pendingKYC,
    pendingResolution,
    depositSuccessRate:    depositTotal > 0 ? parseFloat((depositOk / depositTotal).toFixed(4)) : 0,
    kycCompletionRate:     totalUsers > 0 ? parseFloat((verifiedUsers / totalUsers).toFixed(4)) : 0,
    marketsActivityRate:   totalMarkets > 0 ? parseFloat((marketsWithActivity / totalMarkets).toFixed(4)) : 0,
    failedPayouts,
    referralStats: {
      totalReferrals:    referralTotal,
      pendingReferrals:  referralPending,
      totalPaidKes:      referralTotalPaidKes,
    },
  });
}
