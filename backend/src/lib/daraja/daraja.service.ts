// src/lib/daraja/daraja.service.ts
// Safaricom Daraja API integration for CheckRada
// Handles: M-Pesa STK Push (deposits / challenge stakes) + B2C (withdrawals)
//
// AUTH: OAuth 2.0 token — expires every 3,599 seconds (~1 hour).
//   Token is cached in Redis under 'daraja:token' with a 3,500-second TTL.
//   Every API call routes through getDarajaToken(), which hits Redis first.
//   If Redis is unavailable the token is fetched fresh and used without caching.
//
// AMOUNTS: whole KES shillings — NO kobo conversion (unlike Paystack).
// PHONE FORMAT: 254XXXXXXXXX (no leading +). Use darajaPhone() for normalisation.
// REFERENCE: AccountReference ≤ 12 chars. Use generateDarajaRef() for safe refs.

import { getRedis }    from '@/lib/db/redis';
import { randomBytes } from 'crypto';

const DARAJA_BASE     = 'https://api.safaricom.co.ke';
const SHORT_CODE      = process.env.DARAJA_BUSINESS_SHORT_CODE!;
const PASSKEY         = process.env.DARAJA_PASSKEY!;
const CONSUMER_KEY    = process.env.DARAJA_CONSUMER_KEY!;
const CONSUMER_SECRET = process.env.DARAJA_CONSUMER_SECRET!;
const CALLBACK_SECRET = process.env.DARAJA_CALLBACK_SECRET!;
const API_BASE        = process.env.NEXT_PUBLIC_BASE_URL!; // https://api.checkrada.co.ke

const TOKEN_REDIS_KEY = 'daraja:token';
const TOKEN_TTL_SEC   = 3500; // refresh 99 seconds before Safaricom's 3,599-second expiry

// ── Timestamp helper ──────────────────────────────────────────────────────────
// Daraja requires YYYYMMDDHHmmss — built manually to avoid locale/timezone issues.

function darajaTimestamp(): string {
  const n   = new Date();
  const pad = (v: number, len = 2) => String(v).padStart(len, '0');
  return (
    n.getFullYear()        +
    pad(n.getMonth() + 1)  +
    pad(n.getDate())       +
    pad(n.getHours())      +
    pad(n.getMinutes())    +
    pad(n.getSeconds())
  );
}

// ── OAuth token management ────────────────────────────────────────────────────

async function getDarajaToken(): Promise<string> {
  const redis = getRedis();

  // 1. Try Redis cache
  try {
    const cached = await redis.get(TOKEN_REDIS_KEY);
    if (cached) return cached;
  } catch {
    // Redis unavailable — fall through to fresh fetch
  }

  // 2. Fetch fresh token from Safaricom
  const credentials = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');

  let res: Response;
  try {
    res = await fetch(
      `${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
      {
        method:  'GET',
        headers: { Authorization: `Basic ${credentials}` },
        signal:  AbortSignal.timeout(10000),
      }
    );
  } catch (err: any) {
    throw new Error(`Daraja OAuth request failed: ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Daraja OAuth error (${res.status}): ${text.slice(0, 120)}`);
  }

  const data  = await res.json();
  const token = data.access_token as string;
  if (!token) throw new Error('Daraja OAuth: missing access_token in response');

  // 3. Cache in Redis (non-fatal if Redis write fails)
  try {
    await redis.set(TOKEN_REDIS_KEY, token, 'EX', TOKEN_TTL_SEC);
    console.log('[Daraja] OAuth token refreshed and cached');
  } catch {
    console.warn('[Daraja] Redis token cache write failed — continuing without cache');
  }

  return token;
}

// ── Phone normalisation ───────────────────────────────────────────────────────
// Daraja STK Push and B2C require 254XXXXXXXXX (12 digits, no + prefix).
// Handles: 07XX, 011X, 254XXXXXXXXX, +254XXXXXXXXX, 255XX (Tanzania), etc.

export function darajaPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('254') && digits.length === 12) return digits;
  if (digits.startsWith('0')   && digits.length === 10) return '254' + digits.slice(1);
  if (digits.length === 9)                               return '254' + digits;
  // International numbers (255, 256, 250 etc.) — pass through as-is
  return digits;
}

// ── Reference generation ──────────────────────────────────────────────────────
// Daraja AccountReference is limited to 12 characters (alphanumeric).
// Format: prefix (3 chars) + 8 uppercase hex chars = 11 chars total.
//   CRD = CheckRada Deposit
//   CRW = CheckRada Withdrawal
//   CRC = CheckRada Challenge

export function generateDarajaRef(prefix: 'CRD' | 'CRW' | 'CRC'): string {
  return prefix + randomBytes(4).toString('hex').toUpperCase();
}

// ── STK Push password ─────────────────────────────────────────────────────────
// Password = base64(BusinessShortCode + Passkey + Timestamp)
// Re-computed per request since timestamp must match the request time.

function stkPassword(timestamp: string): string {
  return Buffer.from(`${SHORT_CODE}${PASSKEY}${timestamp}`).toString('base64');
}

// ── STK Push (Lipa Na M-Pesa Online) ─────────────────────────────────────────

export interface StkPushParams {
  amountKes:        number; // whole KES — no kobo conversion
  phone:            string; // any format — normalised internally
  accountReference: string; // max 12 chars — stored and shown on M-Pesa receipt
  transactionDesc:  string; // max 13 chars — brief description shown to user
}

export interface StkPushResult {
  MerchantRequestID:   string;
  CheckoutRequestID:   string; // ← store as transaction.mpesaRef for callback lookup
  ResponseCode:        string; // '0' = accepted by Safaricom queue
  ResponseDescription: string;
  CustomerMessage:     string; // e.g. "Success. Request accepted for processing"
}

export async function stkPush(params: StkPushParams): Promise<StkPushResult> {
  const token     = await getDarajaToken();
  const timestamp = darajaTimestamp();
  const password  = stkPassword(timestamp);
  const phone     = darajaPhone(params.phone);

  const callbackUrl = `${API_BASE}/api/payments/daraja/stk-callback/${CALLBACK_SECRET}`;

  let res: Response;
  try {
    res = await fetch(`${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        BusinessShortCode: SHORT_CODE,
        Password:          password,
        Timestamp:         timestamp,
        TransactionType:   'CustomerPayBillOnline',
        Amount:            Math.floor(params.amountKes),
        PartyA:            phone,
        PartyB:            SHORT_CODE,
        PhoneNumber:       phone,
        CallBackURL:       callbackUrl,
        AccountReference:  params.accountReference.slice(0, 12),
        TransactionDesc:   params.transactionDesc.slice(0, 13),
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err: any) {
    if (err.name === 'TimeoutError') throw new Error('Daraja STK Push timed out. Please try again.');
    throw err;
  }

  const data = await res.json();

  if (!res.ok || data.ResponseCode !== '0') {
    const msg = data.errorMessage || data.ResponseDescription || 'STK Push request failed';
    console.error(`[Daraja] STK Push failed (${res.status}):`, msg);
    throw new Error(msg);
  }

  console.log(`[Daraja] STK Push queued — CheckoutRequestID: ${data.CheckoutRequestID}`);
  return data as StkPushResult;
}

// ── STK Query (verify payment status by polling) ──────────────────────────────
// Use when a user asks "did my payment go through?" or to investigate stale PENDING.
// The STK callback is authoritative for real-time flow; this is for on-demand checks.

export interface StkQueryResult {
  ResultCode: string; // '0' = success, '1032' = cancelled by user, etc.
  ResultDesc: string;
}

export async function stkQuery(checkoutRequestId: string): Promise<StkQueryResult> {
  const token     = await getDarajaToken();
  const timestamp = darajaTimestamp();
  const password  = stkPassword(timestamp);

  let res: Response;
  try {
    res = await fetch(`${DARAJA_BASE}/mpesa/stkpushquery/v1/query`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        BusinessShortCode: SHORT_CODE,
        Password:          password,
        Timestamp:         timestamp,
        CheckoutRequestID: checkoutRequestId,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err: any) {
    throw new Error(`Daraja STK Query failed: ${err.message}`);
  }

  const data = await res.json();
  return {
    ResultCode: String(data.ResultCode ?? data.errorCode ?? '1'),
    ResultDesc: data.ResultDesc || data.errorMessage || 'Unknown status',
  };
}

// ── B2C — Business to Customer (Withdrawals) ──────────────────────────────────
// Sends KES directly from the Paybill to a user's M-Pesa.
// No processing fee — user receives the full requested amount.
//
// SETUP REQUIRED (pending Safaricom Business Portal activation):
//   DARAJA_INITIATOR_NAME      — API operator username from the Business Portal
//   DARAJA_SECURITY_CREDENTIAL — initiator password RSA-encrypted with Safaricom's
//                                 public X.509 certificate. One-time generation via
//                                 tools/generate-b2c-credential.ts once credentials
//                                 are confirmed from Safaricom.
//
// Once env vars are set, this function is fully operational.

export interface B2CParams {
  amountKes: number; // whole KES — full amount sent to user (no fee deducted)
  phone:     string; // recipient M-Pesa — any format, normalised internally
  reference: string; // ≤ 11 chars, stored as OriginatorConversationID for lookup
  occasion?: string; // optional note on M-Pesa receipt
}

export interface B2CResult {
  OriginatorConversationID: string; // ← store as transaction.mpesaRef for B2C callback lookup
  ConversationID:           string;
  ResponseCode:             string; // '0' = accepted
  ResponseDescription:      string;
}

export async function b2cTransfer(params: B2CParams): Promise<B2CResult> {
  const initiatorName = process.env.DARAJA_INITIATOR_NAME;
  const securityCred  = process.env.DARAJA_SECURITY_CREDENTIAL;

  if (!initiatorName || !securityCred) {
    throw new Error(
      'B2C withdrawals are not yet configured. ' +
      'DARAJA_INITIATOR_NAME and DARAJA_SECURITY_CREDENTIAL must be set. ' +
      'Retrieve Initiator Name from Safaricom Business Portal → M-Pesa → B2C.'
    );
  }

  // Diagnostic: confirms exact values being sent without printing secrets
  console.log('[Daraja B2C Diag]',
    `InitiatorName="${initiatorName}" (len=${initiatorName.length})`,
    `| SecCred len=${securityCred.length}`,
    `| SecCred starts="${securityCred.slice(0,4)}" ends="${securityCred.slice(-4)}"`,
    `| SecCred hasWhitespace=${/\s/.test(securityCred)}`,
    `| PartyA(ShortCode)="${SHORT_CODE}"`,
    `| PartyB(Phone)="${darajaPhone(params.phone)}"`,
  );

  const token      = await getDarajaToken();
  const phone      = darajaPhone(params.phone);
  const resultUrl  = `${API_BASE}/api/payments/daraja/b2c-result/${CALLBACK_SECRET}`;
  const timeoutUrl = `${API_BASE}/api/payments/daraja/b2c-timeout/${CALLBACK_SECRET}`;

  let res: Response;
  try {
    res = await fetch(`${DARAJA_BASE}/mpesa/b2c/v1/paymentrequest`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        OriginatorConversationID: params.reference,
        InitiatorName:            initiatorName,
        SecurityCredential:       securityCred,
        CommandID:                'BusinessPayment',
        Amount:                   Math.floor(params.amountKes),
        PartyA:                   SHORT_CODE,
        PartyB:                   phone,
        Remarks:                  'CheckRada Withdrawal',
        QueueTimeOutURL:          timeoutUrl,
        ResultURL:                resultUrl,
        Occasion:                 (params.occasion ?? '').slice(0, 100),
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err: any) {
    if (err.name === 'TimeoutError') throw new Error('Daraja B2C request timed out. Please try again.');
    throw err;
  }

  const data = await res.json();

  if (!res.ok || data.ResponseCode !== '0') {
    const msg = data.errorMessage || data.ResponseDescription || 'B2C transfer failed';
    console.error(`[Daraja] B2C failed (${res.status}):`, msg);
    throw new Error(msg);
  }

  console.log(`[Daraja] B2C queued — OriginatorConvID: ${data.OriginatorConversationID}`);
  return data as B2CResult;
}
