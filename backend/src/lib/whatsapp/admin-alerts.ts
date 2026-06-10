// src/lib/whatsapp/admin-alerts.ts
// Admin WhatsApp alert delivery via Meta Cloud API.
//
// Companion to whatsapp-notifications.ts — same Business Account, same
// credentials, but fundamentally different design:
//
//   User notifications  → require userId, respect opt-out, respect kill switches
//   Admin alerts        → no userId, no opt-out, no DB config, always-send
//
// Recipients come from ADMIN_ALERT_PHONES env var (comma-separated E164
// without '+', e.g. "254712346789,254700123456"). Add/remove contacts by
// editing the Vercel environment variable — no code change or redeployment
// of business logic required.
//
// Templates use NAMED parameters ({{proposer_name}} syntax) approved in Meta.
// The Meta API body uses parameter_name to map values to template variables.
//
// FAIL-CLOSED: never throws. Every error path resolves to a logged warning.
// Admin alerts must not break the route that triggered them.
//
// FIRE-AND-FORGET: callers use `void sendAdminAlert(...)` — the function
// handles its own concurrency (parallel sends to all contacts).

const META_API_VERSION = 'v19.0';

// ─── PII redaction (same pattern as whatsapp-notifications.ts) ───────────────

function redactPhone(phone: string): string {
  if (phone.length < 8) return '****';
  return `${phone.slice(0, 4)}****${phone.slice(-4)}`;
}

// ─── Named parameter interface ───────────────────────────────────────────────
// Meta named-variable templates require { parameter_name, text } pairs
// rather than positional { text } pairs.

export interface AdminAlertParam {
  name:  string;   // matches {{variable_name}} in the approved template
  value: string;   // runtime value sent to recipient
}

// ─── Template definitions ────────────────────────────────────────────────────

export type AdminAlertKey =
  | 'ADMIN_PROPOSAL'
  | 'ADMIN_DISPUTE'
  | 'ADMIN_BALANCE'
  | 'ADMIN_MARKET';

const ADMIN_TEMPLATE_NAMES: Record<AdminAlertKey, string> = {
  ADMIN_PROPOSAL: 'checkrada_admin_proposal',
  ADMIN_DISPUTE:  'checkrada_admin_dispute',
  ADMIN_BALANCE:  'checkrada_admin_balance',
  ADMIN_MARKET:   'checkrada_admin_market',
};

// ─── Main send function ───────────────────────────────────────────────────────

export async function sendAdminAlert(
  key:    AdminAlertKey,
  params: AdminAlertParam[],
): Promise<void> {
  try {
    // ── Read credentials ────────────────────────────────────────────────────
    const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
      console.warn('[AdminAlert] SKIP — WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN not set');
      return;
    }

    // ── Read recipient list ─────────────────────────────────────────────────
    const raw = process.env.ADMIN_ALERT_PHONES ?? '';
    const phones = raw
      .split(',')
      .map(p => p.trim())
      .filter(p => p.length >= 9);  // basic sanity check

    if (!phones.length) {
      console.warn('[AdminAlert] SKIP — ADMIN_ALERT_PHONES env var is empty or not set');
      return;
    }

    const templateName = ADMIN_TEMPLATE_NAMES[key];

    // ── Build body component with named parameters ──────────────────────────
    // Meta named-variable format (required for templates using {{variable_name}}):
    // { type: 'text', parameter_name: 'variable_name', text: 'value' }
    const bodyComponent = params.length > 0 ? [{
      type: 'body',
      parameters: params.map(p => ({
        type:           'text',
        parameter_name: p.name,
        text:           String(p.value).slice(0, 1024), // Meta hard limit
      })),
    }] : [];

    const url = `https://graph.facebook.com/${META_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

    // ── Send to all contacts in parallel ───────────────────────────────────
    // allSettled so one failure doesn't block the others.
    const sends = phones.map(async (phone) => {
      const e164 = phone.startsWith('+') ? phone : `+${phone}`;
      const payload = {
        messaging_product: 'whatsapp',
        to:                e164,
        type:              'template',
        template: {
          name:       templateName,
          language:   { code: 'en' },
          ...(bodyComponent.length > 0 ? { components: bodyComponent } : {}),
        },
      };

      try {
        const res = await fetch(url, {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${ACCESS_TOKEN}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '(no body)');
          console.error(
            `[AdminAlert] Meta API error ${res.status} sending ${key} to ${redactPhone(phone)}: ` +
            errText.slice(0, 300)
          );
          return;
        }

        const data = await res.json().catch(() => null);
        const msgId = data?.messages?.[0]?.id ?? '(no id)';
        console.log(`[AdminAlert] Sent ${key} to ${redactPhone(phone)} — msg id ${msgId}`);

      } catch (err) {
        console.error(`[AdminAlert] Network error sending ${key} to ${redactPhone(phone)}:`, err);
      }
    });

    await Promise.allSettled(sends);

  } catch (err) {
    // Top-level catch — admin alerts must never propagate errors to callers.
    console.error('[AdminAlert] Unexpected error in sendAdminAlert:', err);
  }
}
