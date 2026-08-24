// backend/src/app/api/admin/payments/c2b-deposits/route.ts
//
// GET — list Paybill deposits needing (or having needed) manual attention.
// Defaults to PENDING (the active queue); ?status=FAILED or ?status=SUCCESS
// for history. Capped at 100 rows — this is expected to be a small, rare
// fallback queue, not a high-volume list.
//
// The requested status is whitelisted against the known enum values before
// it ever reaches Prisma — an unrecognised value (typo, probing, whatever)
// falls back to PENDING rather than letting Postgres reject an invalid
// enum value and surface as an unhandled 500.

import { NextRequest, NextResponse } from 'next/server';
import { prisma }                    from '@/lib/db/prisma';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';
import { withErrorHandling }         from '@/lib/security/route-guard';

export const dynamic = 'force-dynamic';

const VALID_STATUSES = ['PENDING', 'SUCCESS', 'FAILED'] as const;
type ValidStatus = typeof VALID_STATUSES[number];

export const GET = withErrorHandling(async (req: NextRequest) => {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const requested = req.nextUrl.searchParams.get('status');
  const status: ValidStatus = VALID_STATUSES.includes(requested as ValidStatus)
    ? (requested as ValidStatus)
    : 'PENDING';

  const rows = await prisma.transaction.findMany({
    where:   { type: 'DEPOSIT', userId: null, status },
    orderBy: { createdAt: 'desc' },
    take:    100,
  });

  return NextResponse.json({
    deposits: rows.map(r => ({
      ...r,
      amountKes: Number(r.amountKes),
    })),
  });
});
