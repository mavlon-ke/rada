// src/lib/api/client.ts
// Typed API client for Rada frontend — replaces all mock data

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? '';

// ── TOKEN MANAGEMENT ─────────────────────────────────────────────────────────

let _token: string | null = null;

export function setToken(token: string) {
  _token = token;
  if (typeof window !== 'undefined') localStorage.setItem('pke_token', token);
}

export function getToken(): string | null {
  if (_token) return _token;
  if (typeof window !== 'undefined') _token = localStorage.getItem('pke_token');
  return _token;
}

export function clearToken() {
  _token = null;
  if (typeof window !== 'undefined') localStorage.removeItem('pke_token');
}

// ── BASE FETCH ────────────────────────────────────────────────────────────────

class APIError extends Error {
  constructor(public status: number, public body: any) {
    super(body?.error ?? `API error ${status}`);
  }
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) throw new APIError(res.status, data);
  return data as T;
}

const api = {
  get:    <T>(path: string)                   => apiFetch<T>(path),
  post:   <T>(path: string, body: unknown)    => apiFetch<T>(path, { method: 'POST',   body: JSON.stringify(body) }),
  patch:  <T>(path: string, body: unknown)    => apiFetch<T>(path, { method: 'PATCH',  body: JSON.stringify(body) }),
  delete: <T>(path: string)                   => apiFetch<T>(path, { method: 'DELETE' }),
};

// ── TYPES ─────────────────────────────────────────────────────────────────────

export type Category   = 'GENERAL' | 'POLITICS' | 'ECONOMY' | 'ENTERTAINMENT' | 'WEATHER' | 'TECH' | 'FRIENDS';
export type MarketStatus = 'OPEN' | 'CLOSED' | 'RESOLVED' | 'CANCELLED';
export type Side       = 'YES' | 'NO';
export type KycStatus  = 'PENDING' | 'VERIFIED' | 'REJECTED';
export type TxType     = 'DEPOSIT' | 'WITHDRAWAL' | 'TRADE_BUY' | 'TRADE_SELL' | 'PAYOUT' | 'REFUND';

export interface User {
  id:          string;
  phone:       string;
  name:        string | null;
  email:       string | null;
  kycStatus:   KycStatus;
  balanceKes:  number;
  createdAt:   string;
}

export interface Market {
  id:          string;
  title:       string;
  description: string;
  category:    Category;
  imageUrl:    string | null;
  status:      MarketStatus;
  outcome:     'YES' | 'NO' | null;
  yesPool:     number;
  noPool:      number;
  yesPrice:    number;  // enriched by API
  noPrice:     number;  // enriched by API
  tradeCount:  number;  // enriched by API
  closesAt:    string;
  resolvedAt:  string | null;
  createdAt:   string;
}

export interface Position {
  id:         string;
  userId:     string;
  marketId:   string;
  market:     Market;
  side:       Side;
  shares:     number;
  avgPrice:   number;
  realizedPnl: number;
  currentValue: number; // enriched
  unrealizedPnl: number; // enriched
}

export interface Order {
  id:            string;
  marketId:      string;
  market:        { title: string };
  side:          Side;
  amountKes:     number;
  shares:        number;
  pricePerShare: number;
  status:        'PENDING' | 'FILLED' | 'CANCELLED';
  createdAt:     string;
}

export interface Transaction {
  id:          string;
  type:        TxType;
  amountKes:   number;
  balAfter:    number;
  mpesaRef:    string | null;
  description: string | null;
  status:      'PENDING' | 'SUCCESS' | 'FAILED';
  createdAt:   string;
}

export interface LeaderboardEntry {
  rank:    number;
  userId:  string;
  name:    string;
  profit:  number;
  trades:  number;
  winRate: number;
  volume:  number;
  isMe:    boolean;
}

export interface PortfolioHistory {
  date:          string;
  portfolioValue: number;
  deposited:     number;
}

// ── AUTH ─────────────────────────────────────────────────────────────────────

export const auth = {
  /** Send OTP to phone number */
  requestOTP: (phone: string) =>
    api.post<{ message: string }>('/api/auth/otp/request', { phone }),

  /** Verify OTP, receive JWT */
  verifyOTP: async (phone: string, code: string) => {
    const res = await api.post<{ token: string; user: User }>('/api/auth/otp/verify', { phone, code });
    setToken(res.token);
    return res;
  },

  /** Get current user */
  me: () => api.get<User>('/api/auth/me'),

  logout: () => clearToken(),
};

// ── MARKETS ──────────────────────────────────────────────────────────────────

export const markets = {
  list: (params?: { category?: Category; status?: MarketStatus; page?: number }) => {
    const q = new URLSearchParams();
    if (params?.category) q.set('category', params.category);
    if (params?.status)   q.set('status',   params.status);
    if (params?.page)     q.set('page',      String(params.page));
    return api.get<{ markets: Market[]; page: number; limit: number }>(
      `/api/markets${q.toString() ? `?${q}` : ''}`
    );
  },

  get: (marketId: string) =>
    api.get<{ market: Market }>(`/api/markets/${marketId}`),

  create: (data: {
    title: string;
    description: string;
    category: Category;
    closesAt: string;
    imageUrl?: string;
  }) => api.post<{ market: Market }>('/api/markets', data),

  /** Buy YES or NO shares */
  trade: (marketId: string, side: Side, amountKes: number) =>
    api.post<{
      success:      boolean;
      order:        Order;
      shares:       number;
      pricePerShare: number;
      newYesPrice:  number;
    }>(`/api/markets/${marketId}/trade`, { side, amountKes }),
};

// ── PAYMENTS ─────────────────────────────────────────────────────────────────

export const payments = {
  /** Initiate M-Pesa STK Push deposit */
  deposit: (amountKes: number, phone: string) =>
    api.post<{
      success:           boolean;
      message:           string;
      checkoutRequestId: string;
      transactionId:     string;
    }>('/api/payments/deposit', { amountKes, phone }),

  /** Poll deposit status (call every 3s until resolved) */
  pollDeposit: (checkoutRequestId: string) =>
    api.get<{
      status:    'PENDING' | 'SUCCESS' | 'FAILED';
      mpesaRef?: string;
      amount?:   number;
    }>(`/api/payments/deposit/status?id=${checkoutRequestId}`),

  /** Initiate M-Pesa B2C withdrawal */
  withdraw: (amountKes: number, phone: string) =>
    api.post<{
      success:       boolean;
      message:       string;
      fee:           number;
      transactionId: string;
    }>('/api/payments/withdraw', { amountKes, phone }),
};

// ── USER / PORTFOLIO ─────────────────────────────────────────────────────────

export const portfolio = {
  /** Open positions with current market value */
  positions: () =>
    api.get<{ positions: Position[] }>('/api/users/me/positions'),

  /** Transaction history */
  transactions: (page = 1) =>
    api.get<{ transactions: Transaction[]; total: number; page: number }>(
      `/api/users/me/transactions?page=${page}`
    ),

  /** Portfolio value over time for chart */
  history: (period: '7d' | '30d' | 'all') =>
    api.get<{ history: PortfolioHistory[] }>(
      `/api/users/me/portfolio-history?period=${period}`
    ),

  /** Summary stats */
  stats: () =>
    api.get<{
      totalPnl:      number;
      openValue:     number;
      winRate:       number;
      totalWins:     number;
      totalLosses:   number;
      bestTrade:     number;
      worstTrade:    number;
      avgHoldDays:   number;
      totalVolume:   number;
    }>('/api/users/me/stats'),
};

// ── LEADERBOARD ──────────────────────────────────────────────────────────────

export const leaderboard = {
  get: (period: '7d' | '30d' | 'all' = '30d', category?: Category) => {
    const q = new URLSearchParams({ period });
    if (category) q.set('category', category);
    return api.get<{
      entries: LeaderboardEntry[];
      myRank:  number;
      nextRank: { rank: number; profitNeeded: number } | null;
    }>(`/api/leaderboard?${q}`);
  },
};

export default { auth, markets, payments, portfolio, leaderboard };
