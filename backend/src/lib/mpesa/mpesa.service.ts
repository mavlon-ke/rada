// src/lib/mpesa/mpesa.service.ts
// Safaricom Daraja API integration for deposits (STK Push) and withdrawals (B2C)

import axios from "axios";

const DARAJA_BASE =
  process.env.MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY!;
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET!;
const SHORTCODE = process.env.MPESA_SHORTCODE!;         // Your paybill/till number
const PASSKEY = process.env.MPESA_PASSKEY!;             // From Daraja portal
const B2C_INITIATOR = process.env.MPESA_B2C_INITIATOR!;
const B2C_SECURITY = process.env.MPESA_B2C_SECURITY!;  // Encrypted security credential

// ─── AUTH ─────────────────────────────────────────────────────────────────────

let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const credentials = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");

  const { data } = await axios.get(`${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  });

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (parseInt(data.expires_in) - 60) * 1000,
  };

  return cachedToken.token;
}

// ─── STK PUSH (Deposit) ───────────────────────────────────────────────────────

export interface STKPushParams {
  phone: string;       // Format: 254XXXXXXXXX (no +)
  amountKes: number;   // Must be whole number (KES)
  accountRef: string;  // e.g. "RADA-DEP-userId"
  description: string;
}

export interface STKPushResponse {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
  ResponseDescription: string;
  CustomerMessage: string;
}

export async function initiateSTKPush(params: STKPushParams): Promise<STKPushResponse> {
  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const password = getPassword(timestamp);

  const { data } = await axios.post<STKPushResponse>(
    `${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`,
    {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(params.amountKes),
      PartyA: params.phone,
      PartyB: SHORTCODE,
      PhoneNumber: params.phone,
      CallBackURL: `${process.env.NEXT_PUBLIC_BASE_URL}/api/payments/mpesa/callback`,
      AccountReference: params.accountRef,
      TransactionDesc: params.description,
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return data;
}

// ─── STK PUSH QUERY (Check deposit status) ────────────────────────────────────

export async function queryStkPush(checkoutRequestId: string) {
  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const password = getPassword(timestamp);

  const { data } = await axios.post(
    `${DARAJA_BASE}/mpesa/stkpushquery/v1/query`,
    {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return data;
}

// ─── B2C PAYMENT (Withdrawal) ─────────────────────────────────────────────────

export interface B2CParams {
  phone: string;        // 254XXXXXXXXX
  amountKes: number;
  remarks: string;      // e.g. "Rada Withdrawal"
  occasion?: string;
}

export async function initiateB2C(params: B2CParams) {
  const token = await getAccessToken();

  const { data } = await axios.post(
    `${DARAJA_BASE}/mpesa/b2c/v3/paymentrequest`,
    {
      InitiatorName: B2C_INITIATOR,
      SecurityCredential: B2C_SECURITY,
      CommandID: "BusinessPayment",
      Amount: Math.round(params.amountKes),
      PartyA: SHORTCODE,
      PartyB: params.phone,
      Remarks: params.remarks,
      QueueTimeOutURL: `${process.env.NEXT_PUBLIC_BASE_URL}/api/payments/mpesa/b2c/timeout`,
      ResultURL: `${process.env.NEXT_PUBLIC_BASE_URL}/api/payments/mpesa/b2c/result`,
      Occasion: params.occasion ?? "Withdrawal",
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return data;
}

// ─── CALLBACK PARSERS ─────────────────────────────────────────────────────────

export interface STKCallbackBody {
  Body: {
    stkCallback: {
      MerchantRequestID: string;
      CheckoutRequestID: string;
      ResultCode: number;          // 0 = success
      ResultDesc: string;
      CallbackMetadata?: {
        Item: Array<{ Name: string; Value: string | number }>;
      };
    };
  };
}

export function parseSTKCallback(body: STKCallbackBody) {
  const cb = body.Body.stkCallback;
  const success = cb.ResultCode === 0;

  if (!success) {
    return { success: false, checkoutRequestId: cb.CheckoutRequestID };
  }

  const items = cb.CallbackMetadata!.Item;
  const get = (name: string) => items.find((i) => i.Name === name)?.Value;

  return {
    success: true,
    checkoutRequestId: cb.CheckoutRequestID,
    mpesaRef: get("MpesaReceiptNumber") as string,
    amountKes: get("Amount") as number,
    phone: get("PhoneNumber") as string,
    transactionDate: get("TransactionDate") as string,
  };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-T:.Z]/g, "")
    .slice(0, 14);
}

function getPassword(timestamp: string): string {
  return Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString("base64");
}

export function formatPhone(phone: string): string {
  // Normalize to 254XXXXXXXXX
  const cleaned = phone.replace(/\D/g, "");
  if (cleaned.startsWith("0")) return `254${cleaned.slice(1)}`;
  if (cleaned.startsWith("+")) return cleaned.slice(1);
  return cleaned;
}
