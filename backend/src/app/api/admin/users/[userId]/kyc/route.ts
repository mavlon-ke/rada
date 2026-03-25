// src/app/api/admin/users/[userId]/kyc/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';


const Schema = z.object({
  action: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { userId: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const body   = await req.json();
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { action, reason } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: params.userId } });
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const newStatus = action === 'APPROVE' ? 'VERIFIED' : 'REJECTED';

  await prisma.user.update({
    where: { id: params.userId },
    data: { kycStatus: newStatus },
  });

 
  return NextResponse.json({ success: true, userId: params.userId, kycStatus: newStatus });
}
