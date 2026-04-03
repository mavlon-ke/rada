// src/app/api/data/applications/[id]/route.ts
// PATCH /api/data/applications/[id] — approve or reject a data API application

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized, logAdminAction } from '@/lib/auth/admin';

const Schema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'PENDING']),
  notes:  z.string().max(500).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const application = await prisma.dataApplication.findUnique({
    where: { id: params.id },
  });
  if (!application) {
    return NextResponse.json({ error: 'Application not found' }, { status: 404 });
  }

  const body   = await req.json();
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const updated = await prisma.dataApplication.update({
    where: { id: params.id },
    data: {
      status: parsed.data.status,
      notes:  parsed.data.notes,
    },
  });

  await logAdminAction(
    admin.id,
    'DATA_APPLICATION_' + parsed.data.status,
    params.id,
    { refNumber: application.refNumber, org: application.orgName, plan: application.planInterest },
    req
  );

  return NextResponse.json({ success: true, application: updated });
}
