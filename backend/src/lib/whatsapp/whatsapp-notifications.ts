// src/lib/whatsapp/whatsapp-notifications.ts
// WhatsApp notification delivery via Meta Cloud API.
//
// Companion to whatsapp-otp.ts — same Meta account, same auth, different
// template namespace. OTP and notifications share infrastructure, which means
// a single Meta WhatsApp Business account suspension affects BOTH equally.
// This is known and accepted: same channel for auth and notifications matches
// Kenyan user expectations.
//
// FAIL-CLOSED design:
// This module NEVER throws. Every error path resolves to a logged warning.
// Failure to send a WhatsApp message MUST NOT break notification creation,
// which remains the source-of-truth in-app surface.
//
// FOUR KILL-SWITCH LAYERS (all must allow):
//   1. Env var  WHATSAPP_NOTIFS_ENABLED=true  (defaults to OFF — log-only)
//   2. WhatsappConfig.globalEnabled            (admin emergency switch)
//   3. WhatsappConfig.<type>Enabled            (per-type admin toggle)
//   4. User.whatsappOptedOut !== true          (per-user opt-out via STOP reply)
//
// If ANY layer denies, the send is skipped and logged.
//
// LOG SAFETY:
// Phone numbers are redacted in logs (last 4 digits only) to prevent PII
// disclosure via Vercel log access. Bearer tokens and access_token values
// are scrubbed from any Meta error body before logging.

import { prisma } from '@/lib/db/prisma';
import { normaliseToE164 } from './whatsapp-otp';

const META_API_VERSION = 'v19.0';

// ─── PII redaction helpers ────────────────────────────────────────────────────

/**
 * Redact a phone number for logging.
 * "+254712345678" → "+254****5678"
 * Keeps country code prefix and last 4 digits, masks the middle.
 */
function redactPhone(phone: string | null | undefined): string {
  if (!phone) return '(null)';
  if (phone.length < 8) return '****';
  const prefix = phone.slice(0, 4);  // +254 or similar
  const last4  = phone.slice(-4);
  return `${prefix}****${last4}`;
}

/**
 * Scrub bearer tokens and access_token values from log output.
 * Defensive — Meta does not normally echo auth in error bodies, but if any
 * intermediary or future API change did, we'd leak credentials.
 */
function scrubSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, 'Bearer [REDACTED]')
    .replace(/access_token["':\s=]+[A-Za-z0-9_\-.]+/gi, 'access_token=[REDACTED]');
}

// ─── Template name mapping ────────────────────────────────────────────────────
// Maps internal template keys to the approved Meta template name.
// ALL templates must be approved in Meta Business Manager before sending.

export type WhatsAppTemplateKey =
  | 'DEPOSIT_CONFIRMED'
  | 'WITHDRAWAL_PROCESSED'
  | 'MARKET_RESOLVED_WON'
  | 'MARKET_RESOLVED_LOST'
  | 'REFERRAL_REWARD_CREDITED'
  | 'REFEREE_NOMINATED'
  | 'CHALLENGE_OPPONENT_STAKED'
  | 'CHALLENGE_RESOLUTION_WINDOW'
  | 'CHALLENGE_RESOLUTION_WARNING';

const TEMPLATE_NAMES: Record<WhatsAppTemplateKey, string> = {
  DEPOSIT_CONFIRMED:           'checkrada_deposit_confirmed',
  WITHDRAWAL_PROCESSED:        'checkrada_withdrawal_processed',
  MARKET_RESOLVED_WON:         'checkrada_market_won',
  MARKET_RESOLVED_LOST:        'checkrada_market_lost',
  REFERRAL_REWARD_CREDITED:    'checkrada_referral_reward',
  REFEREE_NOMINATED:           'checkrada_referee_nominated',
  CHALLENGE_OPPONENT_STAKED:   'checkrada_challenge_staked',
  CHALLENGE_RESOLUTION_WINDOW: 'checkrada_challenge_window',
  CHALLENGE_RESOLUTION_WARNING:'checkrada_challenge_warning',
};

// ─── In-memory config cache (60s TTL) ─────────────────────────────────────────
// Reading WhatsappConfig on every notification send would be wasteful — the
// config rarely changes. 60s is short enough that admin changes feel near-real
// time without hammering the DB.
//
// Note: cache is per-instance (Vercel scales horizontally). Admin endpoint
// calls invalidateWhatsappConfigCache() on its own instance only; other
// instances inherit the 60s eventual consistency. Acceptable for kill switches.

type ConfigFlags = {
  globalEnabled:                       boolean;
  depositConfirmedEnabled:             boolean;
  withdrawalProcessedEnabled:          boolean;
  marketResolvedWonEnabled:            boolean;
  marketResolvedLostEnabled:           boolean;
  referralRewardCreditedEnabled:       boolean;
  refereeNominatedEnabled:             boolean;
  challengeOpponentStakedEnabled:      boolean;
  challengeResolutionWindowEnabled:    boolean;
  challengeResolutionWarningEnabled:   boolean;
};

let configCache: { value: ConfigFlags | null; expiresAt: number } | null = null;

async function getConfigCached(): Promise<ConfigFlags | null> {
  const now = Date.now();
  if (configCache && configCache.expiresAt > now) {
    return configCache.value;
  }

  try {
    const config = await prisma.whatsappConfig.findUnique({
      where: { id: 'singleton' },
    });

    const flags: ConfigFlags | null = config ? {
      globalEnabled:                     config.globalEnabled,
      depositConfirmedEnabled:           config.depositConfirmedEnabled,
      withdrawalProcessedEnabled:        config.withdrawalProcessedEnabled,
      marketResolvedWonEnabled:          config.marketResolvedWonEnabled,
      marketResolvedLostEnabled:         config.marketResolvedLostEnabled,
      referralRewardCreditedEnabled:     config.referralRewardCreditedEnabled,
      refereeNominatedEnabled:           config.refereeNominatedEnabled,
      challengeOpponentStakedEnabled:    config.challengeOpponentStakedEnabled,
      challengeResolutionWindowEnabled:  config.challengeResolutionWindowEnabled,
      challengeResolutionWarningEnabled: config.challengeResolutionWarningEnabled,
    } : null;

    configCache = { value: flags, expiresAt: now + 60_000 };
    return flags;
  } catch (err) {
    console.error('[WhatsAppNotif] Failed to load config:', err);
    return null; // Fail-closed: if we can't read config, don't send.
  }
}

// Exported so the admin endpoint can invalidate the cache after writes.
export function invalidateWhatsappConfigCache() {
  configCache = null;
}

function isTypeEnabled(flags: ConfigFlags, key: WhatsAppTemplateKey): boolean {
  switch (key) {
    case 'DEPOSIT_CONFIRMED':           return flags.depositConfirmedEnabled;
    case 'WITHDRAWAL_PROCESSED':        return flags.withdrawalProcessedEnabled;
    case 'MARKET_RESOLVED_WON':         return flags.marketResolvedWonEnabled;
    case 'MARKET_RESOLVED_LOST':        return flags.marketResolvedLostEnabled;
    case 'REFERRAL_REWARD_CREDITED':    return flags.referralRewardCreditedEnabled;
    case 'REFEREE_NOMINATED':           return flags.refereeNominatedEnabled;
    case 'CHALLENGE_OPPONENT_STAKED':   return flags.challengeOpponentStakedEnabled;
    case 'CHALLENGE_RESOLUTION_WINDOW': return flags.challengeResolutionWindowEnabled;
    case 'CHALLENGE_RESOLUTION_WARNING':return flags.challengeResolutionWarningEnabled;
    default:                             return false;
  }
}

// ─── Main send function ───────────────────────────────────────────────────────
// Never throws. Always resolves. Logs every outcome with PII-redacted phones.

export async function sendWhatsAppNotification(
  userId:      string,
  templateKey: WhatsAppTemplateKey,
  parameters:  string[],
): Promise<void> {
  try {
    // ─── Layer 1: env-var kill switch ────────────────────────────────────────
    const envEnabled = process.env.WHATSAPP_NOTIFS_ENABLED === 'true';
    if (!envEnabled) {
      console.log(`[WhatsAppNotif] LOG-ONLY (env): would send ${templateKey} to user ${userId} with ${parameters.length} params`);
      return;
    }

    // ─── Layer 2 + 3: DB config kill switches ────────────────────────────────
    const flags = await getConfigCached();
    if (!flags) {
      console.log(`[WhatsAppNotif] SKIP (config not loaded): ${templateKey} to user ${userId}`);
      return;
    }
    if (!flags.globalEnabled) {
      console.log(`[WhatsAppNotif] SKIP (global disabled): ${templateKey} to user ${userId}`);
      return;
    }
    if (!isTypeEnabled(flags, templateKey)) {
      console.log(`[WhatsAppNotif] SKIP (type disabled): ${templateKey} to user ${userId}`);
      return;
    }

    // ─── Layer 4: per-user opt-out ───────────────────────────────────────────
    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: { phone: true, whatsappOptedOut: true },
    });
    if (!user) {
      console.warn(`[WhatsAppNotif] SKIP (user not found): ${templateKey} to user ${userId}`);
      return;
    }
    if (user.whatsappOptedOut) {
      console.log(`[WhatsAppNotif] SKIP (user opted out): ${templateKey} to user ${userId}`);
      return;
    }

    // ─── Validate phone ──────────────────────────────────────────────────────
    const e164 = normaliseToE164(user.phone);
    if (!e164) {
      console.warn(`[WhatsAppNotif] SKIP (invalid phone): user ${userId}`);
      return;
    }

    // ─── Validate env credentials ────────────────────────────────────────────
    const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
      console.error(`[WhatsAppNotif] SKIP (missing env): WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN not set`);
      return;
    }

    // ─── Build payload ───────────────────────────────────────────────────────
    const templateName = TEMPLATE_NAMES[templateKey];
    const components: any[] = [];
    if (parameters.length > 0) {
      components.push({
        type: 'body',
        parameters: parameters.map(text => ({ type: 'text', text: String(text) })),
      });
    }

    const payload = {
      messaging_product: 'whatsapp',
      to:                e164,
      type:              'template',
      template: {
        name:     templateName,
        language: { code: 'en' },
        ...(components.length > 0 ? { components } : {}),
      },
    };

    // ─── Send via Meta API ───────────────────────────────────────────────────
    const url = `https://graph.facebook.com/${META_API_VERSION}/${PHONE_NUMBER_ID}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '(no body)');
      const safeBody  = scrubSecrets(errorBody).slice(0, 300);
      console.error(`[WhatsAppNotif] Meta API error ${response.status} sending ${templateKey} to ${redactPhone(e164)}: ${safeBody}`);
      return;
    }

    const data = await response.json().catch(() => null);
    const messageId = data?.messages?.[0]?.id ?? '(no id)';
    console.log(`[WhatsAppNotif] Sent ${templateKey} to user ${userId} (${redactPhone(e164)}) — msg id ${messageId}`);

  } catch (err) {
    // FAIL-CLOSED: catch literally everything. Notifications must not break.
    console.error(`[WhatsAppNotif] Unexpected error sending ${templateKey} to user ${userId}:`, err);
  }
}
