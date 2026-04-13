// src/app/api/admin/users/unsuspend-by-phone/route.ts
// Emergency: unsuspend a user by phone number
// GET /api/admin/users/unsuspend-by-phone?phone=07XXXXXXXXX&secret=CRON_SECRET

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const secret = searchParams.get('secret');
  const phone  = searchParams.get('phone');

  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!phone) {
    return NextResponse.json({ error: 'phone required' }, { status: 400 });
  }

  const digits = phone.replace(/\D/g, '');
  const e164   = digits.startsWith('0') && digits.length === 10
    ? '254' + digits.slice(1) : digits;

  const result = await prisma.user.updateMany({
    where: { phone: { in: [e164, '0' + e164.slice(3)] } },
    data:  { suspended: false },
  });

  return NextResponse.json({
    success: true,
    updated: result.count,
    message: result.count > 0 ? 'User unsuspended.' : 'User not found.',
  });
}
