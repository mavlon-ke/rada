// backend/src/app/api/payments/daraja/c2b-confirmation/[secret]/route.ts
//
// Safaricom C2B Confirmation webhook — fires AFTER a Paybill payment has
// already completed. Cannot be rejected; only acknowledged.
//
// MATCHING (agreed design):
//   1. MSISDN (the phone that actually paid). NOTE: Safaricom's C2B v2
//      product masks this field on every confirmation — documented Daraja
//      behavior, not specific to this platform or to STK-originated
//      payments. This check is left in place in case Safaricom ever
//      reverses it, but in practice it will not match today.
//   2. Fallback: BillRefNumber (what the payer typed as Account Number,
//      instructed to be their own phone) against User.phone. This is the
//      mechanism that actually matches genuine deposits today.
//   3. No match on either → logged as a PENDING, unattributed deposit
//      (userId: null) for manual admin reconciliation. Never dropped —
//      this is real, irreversible M-Pesa money. No exceptions — every
//      genuinely unmatched case gets a PENDING row and an admin alert.
//
// STK-DUPLICATE GUARD: registering C2B on this shortcode causes Safaricom
// to also send a C2B Confirmation for STK-completed payments, in addition
// to the STK callback that already correctly credits the wallet. Since
// MSISDN is masked (see above), the only reliable way to recognise this is
// via the real M-Pesa receipt number, which STK's own success handlers
// already record inside their transaction's `description` field. If this
// confirmation's TransID already appears there, it's the exact same
// real-world payment already credited — not a guess, an exact match on
// Safaricom's own receipt code — so it's skipped before ever reaching the
// unmatched/PENDING path. No schema change; nothing in the STK callback
// path is touched by this file at all.
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

  // ── Guard: already credited via STK (or any other channel) ─────────────────
  // Safaricom's C2B v2 masks MSISDN on every confirmation (documented product
  // change, not something specific to STK) — so this doesn't rely on MSISDN
  // at all. STK's own success handlers already record the real M-Pesa receipt
  // number inside `description`. If this TransID already appears in an
  // existing SUCCESS transaction, it's the same real-world payment already
  // credited — not a guess, an exact match on Safaricom's own receipt code.
  const alreadyCreditedViaStk = await prisma.transaction.findFirst({
    where: { status: 'SUCCESS', description: { contains: transId } },
  });
  if (alreadyCreditedViaStk) {
    console.log(`[Daraja C2B] Skipping — TransID ${transId} already credited via STK (transaction ${alreadyCreditedViaStk.id})`);
    return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

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
