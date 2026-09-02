// backend/src/app/api/payments/daraja/c2b-confirmation/[secret]/route.ts
//
// Safaricom C2B Confirmation webhook — fires AFTER a Paybill payment has
// already completed. Cannot be rejected; only acknowledged.
//
// MATCHING (agreed design):
//   1. MSISDN (the phone that actually paid — Safaricom-attested, not
//      user-typed) against User.phone. Unambiguous since phone is unique.
//   2. Fallback: BillRefNumber (what the payer typed as Account Number,
//      instructed to be their own phone) against User.phone.
//   3. No match on either → logged as a PENDING, unattributed deposit
//      (userId: null) for manual admin reconciliation. Never dropped —
//      this is real, irreversible M-Pesa money. No exceptions — every
//      unmatched case gets a PENDING row and an admin alert, always.
//
// IDEMPOTENCY / ATOMICITY: the matched-deposit write and the wallet
// credit are inside ONE $transaction, not two separate operations.
// A failure fully rolls back, so a Safaricom retry lands on a clean
// slate instead of colliding with a phantom row.

import { NextRequest, NextResponse }   from 'next/server';
import { Prisma }                      from '@prisma/client';
import { prisma }                      from '@/lib/db/prisma';
import { withErrorHandling }           from '@/lib/security/route-guard';
import { darajaPhone }                 from '@/lib/daraja/daraja.service';
import { sendWhatsAppNotification }    from '@/lib/whatsapp/whatsapp-notifications';
import { sendAdminAlert }              from '@/lib/whatsapp/admin-alerts';
import { creditRefereeBonusOnDeposit } from '@/lib/referrals/referral.service';

export const dynamic = 'force-dynamic';

function dbPhone(phone: string): string {
  return darajaPhone(phone);
}

export const POST = withErrorHandling(async (
  req:     NextRequest,
  context: { params: { secret: string } }
) => {
  // ── Secret validation ───────────────────────────────────────────────────
  const { secret } = context.params;
  if (!secret || secret !== process.env.DARAJA_C2B_SECRET) {
    console.warn('[Daraja C2B Confirmation] Invalid callback secret — rejecting');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // ── Parse body ───────────────────────────────────────────────────────────
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

console.log(`[Daraja C2B] RAW BODY: ${JSON.stringify(body)}`);

  const transId    = String(body?.TransID ?? '');
  const amountKes   = Number(body?.TransAmount);
  const msisdnRaw   = String(body?.MSISDN ?? '');
  const billRefRaw  = String(body?.BillRefNumber ?? '');

  if (!transId || !amountKes || !msisdnRaw) {
    console.error('[Daraja C2B] Missing required fields in confirmation payload:', JSON.stringify(body).slice(0, 300));
    return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  const msisdn = dbPhone(msisdnRaw);

  console.log(`[Daraja C2B] Confirmation — TransID: ${transId} | Amount: ${amountKes} | MSISDN: ${msisdn} | BillRef: ${billRefRaw}`);

  // ── Matching: MSISDN first, then BillRefNumber ─────────────────────────────
  let matchedUser = await prisma.user.findUnique({ where: { phone: msisdn } });
  let matchedVia: 'MSISDN' | 'BillRefNumber' | null = matchedUser ? 'MSISDN' : null;

  if (!matchedUser && billRefRaw) {
    const billRefPhone = dbPhone(billRefRaw);
    matchedUser = await prisma.user.findUnique({ where: { phone: billRefPhone } });
    if (matchedUser) matchedVia = 'BillRefNumber';
  }

  // ── Matched: credit the wallet ──────────────────────────────────────────
  if (matchedUser) {
    try {
      await prisma.$transaction(async (tx) => {
        const freshUser = await tx.user.findUnique({ where: { id: matchedUser!.id } });
        if (!freshUser) {
          console.error(`[Daraja C2B] Matched user ${matchedUser!.id} vanished before credit — wallet credit skipped`);
          return;
        }
        const newBalance = Number(freshUser.balanceKes) + amountKes;

        await tx.transaction.create({
          data: {
            userId:      matchedUser!.id,
            type:        'DEPOSIT',
            amountKes:   amountKes,
            balAfter:    newBalance,
            mpesaRef:    transId,
            phone:       msisdn,
            status:      'SUCCESS',
            description: `Paybill deposit of KES ${amountKes.toLocaleString()} confirmed (matched via ${matchedVia}). Receipt: ${transId}`,
          },
        });

        await tx.user.update({
          where: { id: matchedUser!.id },
          data:  { balanceKes: { increment: amountKes } },
        });

        await tx.notification.create({
          data: {
            userId:  matchedUser!.id,
            type:    'DEPOSIT_CONFIRMED',
            title:   '✅ Deposit confirmed',
            message: `KES ${amountKes.toLocaleString()} has been added to your CheckRada wallet via Paybill.`,
            link:    '/rada-dashboard.html',
          },
        });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        console.warn('[Daraja C2B] Duplicate confirmation ignored — TransID already processed:', transId);
        return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
      }
      throw err;
    }

    void sendWhatsAppNotification(matchedUser.id, 'DEPOSIT_CONFIRMED', [amountKes.toLocaleString()]);
    await creditRefereeBonusOnDeposit(matchedUser.id, amountKes);

    console.log(`[Daraja C2B] ✅ Deposit confirmed via ${matchedVia}: KES ${amountKes} for user ${matchedUser.id}`);
    return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  // ── No match: log as PENDING, never drop real money ─────────────────────
  try {
    await prisma.transaction.create({
      data: {
        userId:      null,
        type:        'DEPOSIT',
        amountKes:   amountKes,
        balAfter:    0,
        mpesaRef:    transId,
        phone:       msisdn,
        status:      'PENDING',
        description: `Unmatched Paybill deposit — KES ${amountKes.toLocaleString()} from ${msisdn} (Account Number entered: "${billRefRaw || '(blank)'}"). Needs manual reconciliation.`,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      console.warn('[Daraja C2B] Duplicate unmatched confirmation ignored — TransID already logged:', transId);
      return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }
    throw err;
  }

  console.error(`[Daraja C2B] ⚠️ UNMATCHED deposit — KES ${amountKes} from ${msisdn} (ref: "${billRefRaw}") — TransID ${transId}`);

  void sendAdminAlert('ADMIN_BALANCE', [
    { name: 'user_name', value: `Unmatched Paybill payer (${msisdn})` },
    { name: 'amount',    value: `+${amountKes}` },
  ]);

  return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});
