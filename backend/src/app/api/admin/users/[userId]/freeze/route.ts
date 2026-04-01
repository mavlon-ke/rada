// src/app/api/admin/users/[userId]/freeze/route.ts
// POST — toggle suspended status (freeze / unfreeze)

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';

export async function POST(
  req: NextRequest,
  { params }: { params: { userId: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const user = await prisma.user.findUnique({ where: { id: params.userId } });
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const newSuspended = !user.suspended;

  await prisma.user.update({
    where: { id: params.userId },
    data:  { suspended: newSuspended },
  });

  await logAdminAction(
    admin.id,
    newSuspended ? 'USER_FROZEN' : 'USER_UNFROZEN',
    params.userId,
    { phone: user.phone, name: user.name },
    req
  );

  return NextResponse.json({
    success:   true,
    suspended: newSuspended,
    message:   `User ${user.phone} ${newSuspended ? 'frozen' : 'unfrozen'} successfully.`,
  });
}
