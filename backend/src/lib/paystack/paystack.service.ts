// src/lib/paystack/paystack.service.ts
// Paystack integration for CheckRada
// Supports: M-Pesa STK Push (Kenya mobile money) + Card payments
// Docs: https://paystack.com/docs/api/

import { createHmac, timingSafeEqual } from 'crypto';

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY!;
const PAYSTACK_BASE   = 'https://api.paystack.co';

// ─── Generic request helper ───────────────────────────────────────────────────

async function paystackRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: object
): Promise<T> {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await res.json();

  if (!res.ok || !data.status) {
    console.error('[Paystack] API error:', JSON.stringify(data));
    throw new Error(data.message ?? 'Paystack API error');
  }

  return data.data as T;
}

// ─── Phone normalisation ──────────────────────────────────────────────────────

export function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 10) return '254' + digits.slice(1);
  if (digits.startsWith('254') && digits.length === 12) return digits;
  return digits;
}

// ─── INITIALIZE TRANSACTION ───────────────────────────────────────────────────
// Used for card payments — returns an authorization URL the user visits

export interface InitializeTransactionParams {
  email:      string;   // Paystack requires email — use phone@checkrada.co.ke as fallback
  amountKes:  number;   // In KES (we convert to kobo: KES * 100)
  reference:  string;   // Your unique transaction reference
  callbackUrl: string;  // Where Paystack redirects after card payment
  metadata?:  object;
}

export interface InitializeTransactionResult {
  authorization_url: string;
  access_code:       string;
  reference:         string;
}

export async function initializeTransaction(
  params: InitializeTransactionParams
): Promise<InitializeTransactionResult> {
  return paystackRequest<InitializeTransactionResult>('POST', '/transaction/initialize', {
    email:        params.email,
    amount:       Math.round(params.amountKes * 100), // Paystack uses kobo (1 KES = 100 kobo)
    currency:     'KES',
    reference:    params.reference,
    callback_url: params.callbackUrl,
    metadata:     params.metadata ?? {},
  });
}

// ─── CHARGE M-PESA (STK Push) ─────────────────────────────────────────────────
// Sends STK push directly to user's phone via Paystack

export interface ChargeMpesaParams {
  email:     string;
  amountKes: number;
  phone:     string;   // 254XXXXXXXXX format
  reference: string;
  metadata?: object;
}

export interface ChargeMpesaResult {
  reference:       string;
  status:          string;   // 'send_otp' | 'pay_offline' | 'success' | 'failed'
  display_text:    string;
}

export async function chargeMpesa(
  params: ChargeMpesaParams
): Promise<ChargeMpesaResult> {
  const phone = normalisePhone(params.phone);

  return paystackRequest<ChargeMpesaResult>('POST', '/charge', {
    email:    params.email,
    amount:   Math.round(params.amountKes * 100),
    currency: 'KES',
    reference: params.reference,
    mobile_money: {
      phone,
      provider: 'mpesa',
    },
    metadata: params.metadata ?? {},
  });
}

// ─── VERIFY TRANSACTION ───────────────────────────────────────────────────────
// Call this after callback/webhook to confirm payment

export interface VerifyTransactionResult {
  reference:   string;
  status:      string;   // 'success' | 'failed' | 'abandoned'
  amount:      number;   // in kobo
  currency:    string;
  paid_at:     string;
  metadata:    Record<string, unknown>;
  customer: {
    email: string;
    phone: string;
  };
  channel:     string;   // 'mobile_money' | 'card' etc.
}

export async function verifyTransaction(
  reference: string
): Promise<VerifyTransactionResult> {
  return paystackRequest<VerifyTransactionResult>(
    'GET',
    `/transaction/verify/${encodeURIComponent(reference)}`
  );
}

// ─── INITIATE TRANSFER (Withdrawal) ──────────────────────────────────────────
// Step 1: Create a transfer recipient
// Step 2: Initiate the transfer

export interface CreateRecipientParams {
  name:          string;
  phone:         string;   // 254XXXXXXXXX
  bankCode:      string;   // 'MPesa' for M-Pesa
}

export interface TransferRecipient {
  recipient_code: string;
}

export async function createTransferRecipient(
  params: CreateRecipientParams
): Promise<TransferRecipient> {
  const phone = normalisePhone(params.phone);
  return paystackRequest<TransferRecipient>('POST', '/transferrecipient', {
    type:         'mobile_money',
    name:         params.name,
    account_number: phone,
    bank_code:    'MPesa',
    currency:     'KES',
  });
}

export interface InitiateTransferParams {
  amountKes:      number;
  recipientCode:  string;
  reference:      string;
  reason:         string;
}

export interface TransferResult {
  transfer_code: string;
  status:        string;
}

export async function initiateTransfer(
  params: InitiateTransferParams
): Promise<TransferResult> {
  return paystackRequest<TransferResult>('POST', '/transfer', {
    source:    'balance',
    amount:    Math.round(params.amountKes * 100),
    recipient: params.recipientCode,
    reference: params.reference,
    reason:    params.reason,
    currency:  'KES',
  });
}

// ─── WEBHOOK SIGNATURE VERIFICATION ──────────────────────────────────────────
// SECURITY: Always verify Paystack webhook signatures

export function verifyWebhookSignature(
  payload: string,
  signature: string
): boolean {
  if (!signature || !PAYSTACK_SECRET) return false;

  const expected = createHmac('sha512', PAYSTACK_SECRET)
    .update(payload)
    .digest('hex');

  if (expected.length !== signature.length) return false;

  return timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(signature, 'utf8')
  );
}

// ─── GENERATE REFERENCE ───────────────────────────────────────────────────────

import { randomBytes } from 'crypto';

export function generateReference(prefix: 'DEP' | 'WIT' | 'TRF'): string {
  const rand = randomBytes(8).toString('hex').toUpperCase();
  return `CKR-${prefix}-${rand}`;
}
