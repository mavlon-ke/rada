// src/lib/whatsapp/whatsapp-otp.ts
// WhatsApp OTP delivery via Meta Cloud API
// Replaces: src/lib/sms/africas-talking.ts
// Security audit: v8.0 — 24 March 2026

const META_API_VERSION = 'v19.0';

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`[WhatsApp] Missing env var: ${key}`);
  return v;
}

// ─── Phone Normalisation ──────────────────────────────────────────────────────
// SECURITY: All storage keys use E.164 format to prevent key-collision attacks
// where 0712345678 and 254712345678 could map to different OTP records.

export function normaliseToE164(phone: string): string | null {
  if (!phone || typeof phone !== 'string') return null;

  // Strip all non-digit characters except leading +
  const hasPlus = phone.trimStart().startsWith('+');
  const digits  = phone.replace(/\D/g, '');

  if (digits.length < 5 || digits.length > 15) return null;

  // ── Kenya local formats ────────────────────────────────────────────────────
  // 07XXXXXXXX or 01XXXXXXXX (10 digits, no country code)
  if ((digits.startsWith('07') || digits.startsWith('01')) && digits.length === 10) {
    return '254' + digits.slice(1);
  }

  // ── Already E.164 (with or without leading +) ─────────────────────────────
  // Phone was sent as e.g. "254712345678" or "+254712345678"
  // Digits must be 7–15 chars (ITU-T E.164 max is 15 digits total)
  if (hasPlus || digits.length >= 10) {
    return digits;
  }

  return null;
}

// ─── Send OTP ────────────────────────────────────────────────────────────────
// SECURITY: Returns { otp } only on success — caller must store it.
// OTP is NEVER stored here; the caller decides storage (DB or Redis).

export async function sendWhatsAppOTP(phone: string): Promise<{
  success:   boolean;
  otp?:      string;
  messageId?: string;
  error?:    string;
}> {
  const e164 = normaliseToE164(phone);
  if (!e164) return { success: false, error: 'INVALID_PHONE_FORMAT' };

  // SECURITY: crypto.getRandomValues() — NOT Math.random()
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  const otp = String(array[0] % 1_000_000).padStart(6, '0');

  const PHONE_NUMBER_ID = requireEnv('WHATSAPP_PHONE_NUMBER_ID');
  const ACCESS_TOKEN    = requireEnv('WHATSAPP_ACCESS_TOKEN');
  const TEMPLATE_NAME   = process.env.WHATSAPP_OTP_TEMPLATE_NAME ?? 'checkrada_otp';

  const url = `https://graph.facebook.com/${META_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to: e164,
    type: 'template',
    template: {
      name: TEMPLATE_NAME,
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: otp }],
        },
        {
          type: 'button',
          sub_type: 'copy_code',
          index: 0,
          parameters: [{ type: 'payload', payload: otp }],
        },
      ],
    },
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[WhatsApp OTP] Meta API error:', JSON.stringify(data));
      const code = data?.error?.code;
      if (code === 131026) return { success: false, error: 'NOT_ON_WHATSAPP' };
      if (code === 131047) return { success: false, error: 'TEMPLATE_ERROR' };
      return { success: false, error: 'META_API_ERROR' };
    }

    // Return OTP to caller — stored in DB ONLY after confirmed delivery
    return { success: true, otp, messageId: data?.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp OTP] Network error:', err);
    return { success: false, error: 'NETWORK_ERROR' };
  }
}
