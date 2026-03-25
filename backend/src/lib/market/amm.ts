// src/lib/market/amm.ts
// LMSR (Logarithmic Market Scoring Rule) AMM — Rada v3
// Platform fee: 5% forecasting fee applied at TRADE TIME (Option B) — NOT at resolution.
// Resolution pays winning shares 1:1 with no deduction.
// Minimum stake: KES 20  |  Maximum stake: KES 20,000

const DEFAULT_B = 1000; // Liquidity parameter
// PLATFORM_FEE removed — fee is now collected at trade time in trade/route.ts (Option B).
// These helper functions retain fee params for UI estimation only.

// ─── PRICE ────────────────────────────────────────────────────────────────────

/** YES probability given current pool sizes */
export function getYesPrice(yesPool: number, noPool: number): number {
  const expYes = Math.exp(yesPool / DEFAULT_B);
  const expNo  = Math.exp(noPool  / DEFAULT_B);
  return expYes / (expYes + expNo);
}

export function getNoPrice(yesPool: number, noPool: number): number {
  return 1 - getYesPrice(yesPool, noPool);
}

// ─── COST ─────────────────────────────────────────────────────────────────────

/** Cost in KES to buy `shares` on a given side */
export function costToBuy(
  yesPool: number,
  noPool:  number,
  side:    'YES' | 'NO',
  shares:  number
): number {
  const before = lmsrCost(yesPool, noPool);
  const after  = side === 'YES'
    ? lmsrCost(yesPool + shares, noPool)
    : lmsrCost(yesPool, noPool + shares);
  return after - before;
}

/** Given KES amount → shares received (binary search, no closed form) */
export function sharesToReceive(
  yesPool:   number,
  noPool:    number,
  side:      'YES' | 'NO',
  amountKes: number
): number {
  let lo = 0;
  let hi = amountKes * 100;
  for (let i = 0; i < 64; i++) {
    const mid  = (lo + hi) / 2;
    const cost = costToBuy(yesPool, noPool, side, mid);
    cost < amountKes ? (lo = mid) : (hi = mid);
  }
  return (lo + hi) / 2;
}

/** New pool sizes after a trade */
export function newPools(
  yesPool: number,
  noPool:  number,
  side:    'YES' | 'NO',
  shares:  number
): { yesPool: number; noPool: number } {
  return side === 'YES'
    ? { yesPool: yesPool + shares, noPool }
    : { yesPool, noPool: noPool + shares };
}

// ─── PAYOUT ───────────────────────────────────────────────────────────────────

/**
 * Calculate payout at resolution.
 * Under Option B, the 5% forecasting fee was already taken at trade time.
 * Resolution pays winning shares 1:1 (gross = net).
 * isUnanimous: all stakes refunded in full (no fee).
 * @returns { grossKes, feeKes, netKes }
 */
export function calculatePayout(
  shares:      number,
  side:        'YES' | 'NO',
  outcome:     'YES' | 'NO',
  isUnanimous: boolean = false
): { grossKes: number; feeKes: number; netKes: number } {
  if (side !== outcome) return { grossKes: 0, feeKes: 0, netKes: 0 };

  const grossKes  = shares; // KES 1 per share
  // Fee already collected at trade time — no deduction at resolution
  const feeKes = 0;
  const netKes = isUnanimous ? Math.floor(grossKes) : Math.floor(grossKes);

  return { grossKes: Math.floor(grossKes), feeKes, netKes };
}

/**
 * UI helper — what the payout calculator shows BEFORE resolution.
 * Shows estimated payout at current price so users understand the trade.
 */
export function estimatePayout(
  stakeKes:  number,
  yesPool:   number,
  noPool:    number,
  side:      'YES' | 'NO'
): {
  shares:         number;
  currentPrice:   number;
  grossKes:       number;
  feeKes:         number;
  netKes:         number;
  impliedProb:    string;
} {
  const shares       = sharesToReceive(yesPool, noPool, side, stakeKes);
  const currentPrice = side === 'YES'
    ? getYesPrice(yesPool, noPool)
    : getNoPrice(yesPool, noPool);
  // Under Option B, fee is deducted from the stake before shares are calculated.
  // Here we show the user what they get if they win, based on netAmount entering the AMM.
  const FORECASTING_FEE = 0.05;
  const netStake     = stakeKes * (1 - FORECASTING_FEE); // KES entering AMM after 5% fee
  const grossKes     = shares; // shares computed on netStake
  const feeKes       = stakeKes * FORECASTING_FEE;       // fee shown to user upfront
  const netKes       = grossKes;                         // resolution is fee-free

  return {
    shares:      parseFloat(shares.toFixed(2)),
    currentPrice: parseFloat(currentPrice.toFixed(4)),
    grossKes:    parseFloat(grossKes.toFixed(2)),
    feeKes:      parseFloat(feeKes.toFixed(2)),
    netKes:      parseFloat(netKes.toFixed(2)),
    impliedProb: `${(currentPrice * 100).toFixed(1)}%`,
  };
}

// ─── STAKE VALIDATION ─────────────────────────────────────────────────────────

export const STAKE_MIN_KES  = 20;     // GRA minimum floor
export const STAKE_MAX_KES  = 20_000; // Platform cap per trade

export function validateStake(amountKes: number): { valid: boolean; error?: string } {
  if (amountKes < STAKE_MIN_KES)  return { valid: false, error: `Minimum stake is KES ${STAKE_MIN_KES}` };
  if (amountKes > STAKE_MAX_KES)  return { valid: false, error: `Maximum stake is KES ${STAKE_MAX_KES.toLocaleString()}` };
  if (!Number.isFinite(amountKes)) return { valid: false, error: 'Invalid amount' };
  return { valid: true };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function lmsrCost(yesPool: number, noPool: number): number {
  return DEFAULT_B * Math.log(Math.exp(yesPool / DEFAULT_B) + Math.exp(noPool / DEFAULT_B));
}

export function formatProb(price: number): string {
  return `${(price * 100).toFixed(1)}%`;
}

export function formatKes(amount: number): string {
  return `KES ${amount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
