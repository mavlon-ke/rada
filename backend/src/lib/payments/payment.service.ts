// src/lib/payments/payment.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// UNIFIED PAYMENT SERVICE — ALL ROUTES IMPORT FROM HERE
// ══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Single import point for all payment operations across the platform.
//   Routes never import directly from a provider (daraja.service, etc.).
//   Adding a new payment provider (PawaPay, Peach, etc.) requires:
//     1. Create src/lib/payments/providers/<name>.provider.ts
//     2. Add routing logic in resolveProvider() below
//     3. Add new callback routes at /api/payments/<provider>/...
//     4. Add CSRF exemptions in csrf.ts for new callback paths
//     5. Add env vars to .env.example
//   Routes, DB schema, and frontend require NO changes.
//
// CURRENT STATE:
//   All traffic → Daraja (Safaricom, Kenya, KES).
//   Deposits: STK Push (Lipa Na M-Pesa Online).
//   Withdrawals: B2C (Business to Customer, v1).
//   Callbacks: /api/payments/daraja/stk-callback, b2c-result, b2c-timeout.
//
// FUTURE STATE (PawaPay activation):
//   Uncomment entries in COUNTRY_PROVIDER (types.ts).
//   Add pawapay.provider.ts.
//   Update resolveProvider() below.
//
// ── Re-exports ─────────────────────────────────────────────────────────────────
// All names are re-exported with identical signatures so existing route imports
// compile without any function-call changes — only the import path changes.

import {
  darajaPhone      as _darajaPhone,
  generateDarajaRef as _generateDarajaRef,
  stkPush          as _stkPush,
  stkQuery         as _stkQuery,
  b2cTransfer      as _b2cTransfer,
} from '@/lib/daraja/daraja.service';

export type {
  StkPushParams,
  StkPushResult,
  StkQueryResult,
  B2CParams,
  B2CResult,
} from '@/lib/daraja/daraja.service';

// ── Provider resolver ─────────────────────────────────────────────────────────
// Reads currency/country to route to the correct payment provider.
// Currently always returns 'daraja'. Extend this when PawaPay is activated.

type ProviderName = 'daraja'; // | 'pawapay' when ready

function resolveProvider(country?: string, _currency?: string): ProviderName {
  // Future: uncomment and expand when PawaPay is activated
  // if (_currency && ['TZS','UGX','RWF','GHS','ZMW'].includes(_currency)) return 'pawapay';
  // if (country   && ['TZ','UG','RW','GH','ZM','MW'].includes(country))    return 'pawapay';
  void country; // suppress unused-param warning until routing is active
  return 'daraja';
}

// ── Phone normalisation ───────────────────────────────────────────────────────
// Produces E.164-like format without + prefix (254XXXXXXXXX for Kenya).
// Used by routes for DB lookups and payment provider calls.
// Exported with both the original name (backward compat) and an alias.

export function darajaPhone(phone: string): string {
  return _darajaPhone(phone);
}

// Alias for use in future provider-agnostic code
export const normalisePhone = darajaPhone;

// ── Reference generation ──────────────────────────────────────────────────────
// Generates an 11-char alphanumeric reference (prefix + 8 hex chars).
// Prefix encodes transaction type: CRD=Deposit, CRW=Withdrawal, CRC=Challenge.

export function generateDarajaRef(prefix: 'CRD' | 'CRW' | 'CRC'): string {
  return _generateDarajaRef(prefix);
}

// ── Deposit initiation ────────────────────────────────────────────────────────
// Routes call this to initiate a deposit STK Push (or equivalent for other providers).
// Returns providerRef (CheckoutRequestID) which is stored as transaction.mpesaRef.

export async function stkPush(
  params: Parameters<typeof _stkPush>[0]
): Promise<StkPushResult> {
  const provider = resolveProvider();
  if (provider === 'daraja') return _stkPush(params);
  // if (provider === 'pawapay') return pawapayDeposit(adaptToPawaPay(params));
  throw new Error(`[PaymentService] No deposit handler for provider: ${provider}`);
}

// ── STK Query ─────────────────────────────────────────────────────────────────
// Polls Daraja for the status of a pending STK Push.
// Only relevant for Daraja — PawaPay uses webhooks exclusively.

export async function stkQuery(
  checkoutRequestId: string
): Promise<StkQueryResult> {
  return _stkQuery(checkoutRequestId);
}

// ── Withdrawal initiation ─────────────────────────────────────────────────────
// Routes call this to initiate a withdrawal B2C (or equivalent for other providers).
// Returns providerRef (OriginatorConversationID) stored as transaction.mpesaRef.

export async function b2cTransfer(
  params: Parameters<typeof _b2cTransfer>[0]
): Promise<B2CResult> {
  const provider = resolveProvider();
  if (provider === 'daraja') return _b2cTransfer(params);
  // if (provider === 'pawapay') return pawapayDisbursement(adaptToPawaPay(params));
  throw new Error(`[PaymentService] No withdrawal handler for provider: ${provider}`);
}
