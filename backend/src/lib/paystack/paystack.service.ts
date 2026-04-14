// src/lib/paystack/paystack.service.ts
// Paystack integration for CheckRada
// Supports: M-Pesa STK Push (Kenya mobile money) + Card payments + Transfers (Withdrawals)

import { createHmac, timingSafeEqual } from 'crypto';

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY!;
const PAYSTACK_BASE   = 'https://api.paystack.co';

async function paystackRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: object
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  let res: Response;
  try {
    res = await fetch(`${PAYSTACK_BASE}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('Paystack request timed out. Please try again.');
    throw err;
  }
  clearTimeout(timeout);

  const data = await res.json();
  console.log('[Paystack]', method, path, 'status:', res.status, 'body:', JSON.stringify(data));

  if (!res.ok || !data.status) {
    throw new Error(data.message ?? 'Paystack API error');
  }

  return data.data as T;
}

// Phone normalisation
// STK Push (/charge): requires +254XXXXXXXXX (with + prefix)
export function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('254') && digits.length === 12) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+254' + digits.slice(1);
  if (digits.length === 9) return '+254' + digits;
  return phone;
}

// Transfer Recipient (/transferrecipient): requires 07XXXXXXXX (local format, no + or country code)
export function normalisePhoneForTransfer(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('254') && digits.length === 12) return '0' + digits.slice(3);
  if (digits.startsWith('0') && digits.length === 10) return digits;
  if (digits.length === 9) return '0' + digits;
  return phone;
}

export interface InitializeTransactionParams {
  email:       string;
  amountKes:   number;
  reference:   string;
  callbackUrl: string;
  metadata?:   object;
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
    amount:       Math.round(params.amountKes * 100),
    currency:     'KES',
    reference:    params.reference,
    callback_url: params.callbackUrl,
    metadata:     params.metadata ?? {},
  });
}

export interface ChargeMpesaParams {
  email:     string;
  amountKes: number;
  phone:     string;
  reference: string;
  metadata?: object;
}

export interface ChargeMpesaResult {
  reference:    string;
  status:       string;
  display_text: string;
}

export async function chargeMpesa(
  params: ChargeMpesaParams
): Promise<ChargeMpesaResult> {
  const phone = normalisePhone(params.phone);
  return paystackRequest<ChargeMpesaResult>('POST', '/charge', {
    email:     params.email,
    amount:    Math.round(params.amountKes * 100),
    currency:  'KES',
    reference: params.reference,
    mobile_money: {
      phone,
      provider: 'mpesa',
    },
    metadata: params.metadata ?? {},
  });
}

export interface VerifyTransactionResult {
  reference: string;
  status:    string;
  amount:    number;
  currency:  string;
  paid_at:   string;
  metadata:  Record<string, unknown>;
  customer: {
    email: string;
    phone: string;
  };
  channel: string;
}

export async function verifyTransaction(
  reference: string
): Promise<VerifyTransactionResult> {
  return paystackRequest<VerifyTransactionResult>(
    'GET',
    `/transaction/verify/${encodeURIComponent(reference)}`
  );
}

export interface CreateRecipientParams {
  name:     string;
  phone:    string;
  bankCode: string;
}

export interface TransferRecipient {
  recipient_code: string;
}

export async function createTransferRecipient(
  params: CreateRecipientParams
): Promise<TransferRecipient> {
  // IMPORTANT: /transferrecipient requires 07XXXXXXXX local format, NOT +254XXXXXXXXX
  const phone = normalisePhoneForTransfer(params.phone);
  return paystackRequest<TransferRecipient>('POST', '/transferrecipient', {
    type:           'mobile_money',
    name:           params.name,
    account_number: phone,
    bank_code:      'MPESA',
    currency:       'KES',
  });
}

export interface InitiateTransferParams {
  amountKes:     number;
  recipientCode: string;
  reference:     string;
  reason:        string;
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

import { randomBytes } from 'crypto';

export function generateReference(prefix: 'DEP' | 'WIT' | 'TRF'): string {
  const rand = randomBytes(8).toString('hex').toUpperCase();
  return `CKR-${prefix}-${rand}`;
}
