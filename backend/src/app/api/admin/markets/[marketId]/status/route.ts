// src/app/api/admin/markets/[marketId]/status/route.ts
// Pause (CLOSED) or cancel a market with full refund

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';

const Schema = z.object({
  action: z.enum(['PAUSE', 'CANCEL']),
  reason: z.string().optional(),
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

  const { action, reason } = parsed.data;

  const market = await prisma.market.findUnique({ where: { id: params.marketId } });
  if (!market) return NextResponse.json({ error: 'Market not found' }, { status: 404 });

  if (action === 'PAUSE') {
    await prisma.market.update({
      where: { id: params.marketId },
      data: { status: 'CLOSED' },
    });
    return NextResponse.json({ success: true, action: 'PAUSED' });
  }

  // CANCEL: refund all open positions
  if (action === 'CANCEL') {
    const positions = await prisma.position.findMany({
      where: { marketId: params.marketId, shares: { gt: 0 } },
      include: { user: true },
    });

    await prisma.$transaction(async (tx) => {
      await tx.market.update({
        where: { id: params.marketId },
        data: { status: 'CANCELLED' },
      });

      for (const pos of positions) {
        const refundKes = Number(pos.shares) * Number(pos.avgPrice);

        const updatedUser = await tx.user.update({
          where: { id: pos.userId },
          data: { balanceKes: { increment: refundKes } },
        });

        await tx.transaction.create({
          data: {
            userId:      pos.userId,
            type:        'REFUND',
            amountKes:   refundKes,
            balAfter:    Number(updatedUser.balanceKes),
            status:      'SUCCESS',
            description: `Refund: market cancelled — ${market.title.slice(0, 60)}. Reason: ${reason ?? 'Admin decision'}`,
          },
        });

        // Zero out position
        await tx.position.update({
          where: { id: pos.id },
          data: { shares: 0 },
        });
      }
    });

    return NextResponse.json({
      success:      true,
      action:       'CANCELLED',
      refundedUsers: positions.length,
      reason,
    });
  }
}
