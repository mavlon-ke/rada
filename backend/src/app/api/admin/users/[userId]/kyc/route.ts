// src/app/api/admin/users/[userId]/kyc/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';
import { sendSMS } from '@/lib/sms/africas-talking';

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

  // Notify user via SMS
  const smsMsg = action === 'APPROVE'
    ? `Rada: Your identity has been verified! You can now trade and withdraw. Visit rada.co.ke`
    : `Rada: Your KYC verification was unsuccessful. Reason: ${reason ?? 'Documents unclear'}. Please resubmit at rada.co.ke`;

  if (process.env.NODE_ENV === 'production') {
    await sendSMS(user.phone, smsMsg).catch(console.error);
  } else {
    console.log(`[DEV] KYC SMS to ${user.phone}: ${smsMsg}`);
  }

  return NextResponse.json({ success: true, userId: params.userId, kycStatus: newStatus });
}
