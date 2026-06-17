// src/lib/user/display-name.ts
// Single source of truth for user display names across the platform.
//
// Rule:
//   - Admin-facing surfaces  → raw phone (full number, unmasked)
//   - User-facing surfaces   → displayName() — real name if set, masked phone if not
//
// Masking format: 254722298397 → 0722***397
//   Shows first 4 local digits and last 3, hides the middle 3.
//   Familiar to Kenyan users; enough to recognise a number without exposing it.

/**
 * Converts a Kenyan E164 phone (254XXXXXXXXX) to a masked local format.
 * Works for Safaricom (07XX), Airtel (07XX), Telkom (07XX).
 * Falls back gracefully if the number format is unexpected.
 */
export function maskPhone(phone: string): string {
  if (!phone) return '0***';
  // E164 without '+': 254722298397 → strip 254 prefix → prepend 0
  const local = phone.startsWith('254') ? '0' + phone.slice(3) : phone;
  if (local.length < 7) return local.slice(0, 2) + '***';
  return local.slice(0, 4) + '***' + local.slice(-3);
}

/**
 * Returns the best available display name for a user.
 * Priority: real name → masked phone → 'User'
 *
 * Use this on every user-facing API response that shows another user's identity.
 * Never use on admin-facing routes — admins see the full phone number.
 */
export function displayName(
  name:  string | null | undefined,
  phone: string | null | undefined,
): string {
  if (name  && name.trim())  return name.trim();
  if (phone && phone.trim()) return maskPhone(phone.trim());
  return 'User';
}
