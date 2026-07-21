// src/lib/payments/types.ts
// Shared types for CheckRada's payment abstraction layer.
//
// PURPOSE: Defines the contract every payment provider must implement.
// When adding a new provider (PawaPay, Peach, etc.), implement PaymentProvider
// and register the provider in payment.service.ts resolveProvider().
//
// CURRENT PROVIDERS:
//   daraja  — Safaricom Daraja (Kenya, KES). Always active.
//
// FUTURE PROVIDERS (add when approved):
//   pawapay — PawaPay (TZS/Tanzania, UGX/Uganda, RWF/Rwanda, GHS/Ghana, ZMW/Zambia)
//
// ROUTING: payment.service.ts reads user.currency or user.countryCode to decide
// which provider handles each transaction. Routes never see provider details.

// ── Deposit (user pays into the platform) ─────────────────────────────────────
// Daraja: STK Push (Lipa Na M-Pesa Online)
// PawaPay: Mobile Money collection (USSD push or redirect)

export interface DepositInitParams {
  amountKes:        number;   // amount in platform base currency (KES)
  phone:            string;   // user's mobile number (any format)
  accountReference: string;   // ≤12 chars — shown on user's M-Pesa/mobile receipt
  transactionDesc:  string;   // ≤13 chars — description shown to user
  currency?:        string;   // 'KES' | 'TZS' | 'UGX' | 'RWF' | 'GHS' — default 'KES'
  country?:         string;   // ISO country code 'KE' | 'TZ' | 'UG' | 'RW' | 'GH' — default 'KE'
}

export interface DepositInitResult {
  providerRef:     string;   // CheckoutRequestID (Daraja) / transaction_id (PawaPay)
  customerMessage: string;   // User-facing confirmation message
  // Daraja-specific (present when provider === 'daraja')
  MerchantRequestID?:   string;
  CheckoutRequestID?:   string;
  ResponseCode?:        string;
  ResponseDescription?: string;
  CustomerMessage?:     string;
}

// ── Withdrawal (platform pays out to user) ────────────────────────────────────
// Daraja: B2C (Business to Customer)
// PawaPay: Mobile Money disbursement

export interface WithdrawalInitParams {
  amountKes:  number;   // amount in platform base currency
  phone:      string;   // recipient mobile number
  reference:  string;   // ≤11 chars — internal tracking reference
  occasion?:  string;   // optional note on recipient's receipt
  currency?:  string;   // 'KES' | 'TZS' | 'UGX' etc.
  country?:   string;   // ISO country code
}

export interface WithdrawalInitResult {
  providerRef: string;   // OriginatorConversationID (Daraja) / transaction_id (PawaPay)
  // Daraja-specific
  OriginatorConversationID?: string;
  ConversationID?:           string;
  ResponseCode?:             string;
  ResponseDescription?:      string;
}

// ── Provider routing ──────────────────────────────────────────────────────────
export type ProviderName = 'daraja' | 'pawapay';

// Currencies each provider handles
export const PROVIDER_CURRENCIES: Record<ProviderName, string[]> = {
  daraja:  ['KES'],
  pawapay: ['TZS', 'UGX', 'RWF', 'GHS', 'ZMW', 'XOF', 'MWK'],
};

// Country → provider mapping (extend when activating new regions)
export const COUNTRY_PROVIDER: Record<string, ProviderName> = {
  KE: 'daraja',
  // TZ: 'pawapay',  // Tanzania — activate when PawaPay is approved
  // UG: 'pawapay',  // Uganda
  // RW: 'pawapay',  // Rwanda
  // GH: 'pawapay',  // Ghana
  // ZM: 'pawapay',  // Zambia
  // MW: 'pawapay',  // Malawi
};
