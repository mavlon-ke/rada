// src/lib/api/hooks.ts
// React hooks wrapping the API client — drop these into any component

import { useState, useEffect, useCallback, useRef } from 'react';
import api, {
  Market, Position, Transaction, LeaderboardEntry,
  PortfolioHistory, Category, Side,
} from './client';

// ── GENERIC HOOK FACTORY ──────────────────────────────────────────────────────

interface AsyncState<T> {
  data:    T | null;
  loading: boolean;
  error:   string | null;
  refetch: () => void;
}

function useAsync<T>(fetcher: () => Promise<T>, deps: any[] = []): AsyncState<T> {
  const [data, setData]       = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const counter = useRef(0);

  const run = useCallback(async () => {
    const id = ++counter.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      if (id === counter.current) setData(result);
    } catch (e: any) {
      if (id === counter.current) setError(e.message ?? 'Unknown error');
    } finally {
      if (id === counter.current) setLoading(false);
    }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { run(); }, [run]);

  return { data, loading, error, refetch: run };
}

// ── AUTH HOOKS ────────────────────────────────────────────────────────────────

export function useMe() {
  return useAsync(() => api.auth.me(), []);
}

// ── MARKETS HOOKS ─────────────────────────────────────────────────────────────

export function useMarkets(category?: Category) {
  const { data, loading, error, refetch } = useAsync(
    () => api.markets.list({ category }),
    [category]
  );
  return { markets: data?.markets ?? [], loading, error, refetch };
}

export function useMarket(marketId: string) {
  const { data, loading, error, refetch } = useAsync(
    () => api.markets.get(marketId),
    [marketId]
  );
  return { market: data?.market ?? null, loading, error, refetch };
}

// ── TRADE HOOK ────────────────────────────────────────────────────────────────

interface TradeState {
  trading:   boolean;
  error:     string | null;
  lastTrade: { shares: number; newYesPrice: number } | null;
}

export function useTrade() {
  const [state, setState] = useState<TradeState>({ trading: false, error: null, lastTrade: null });

  const trade = async (marketId: string, side: Side, amountKes: number) => {
    setState(s => ({ ...s, trading: true, error: null }));
    try {
      const result = await api.markets.trade(marketId, side, amountKes);
      setState({ trading: false, error: null, lastTrade: { shares: result.shares, newYesPrice: result.newYesPrice } });
      return result;
    } catch (e: any) {
      setState(s => ({ ...s, trading: false, error: e.message }));
      throw e;
    }
  };

  return { ...state, trade };
}

// ── DEPOSIT HOOK ──────────────────────────────────────────────────────────────

type DepositStep = 'idle' | 'pending' | 'polling' | 'success' | 'failed';

export function useDeposit() {
  const [step, setStep]         = useState<DepositStep>('idle');
  const [error, setError]       = useState<string | null>(null);
  const [mpesaRef, setMpesaRef] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const initiate = async (amountKes: number, phone: string) => {
    setStep('pending');
    setError(null);
    try {
      const { checkoutRequestId } = await api.payments.deposit(amountKes, phone);
      setStep('polling');

      // Poll every 3 seconds for up to 90 seconds
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts++;
        if (attempts > 30) {
          stopPolling();
          setStep('failed');
          setError('Payment timed out. Please try again.');
          return;
        }
        try {
          const status = await api.payments.pollDeposit(checkoutRequestId);
          if (status.status === 'SUCCESS') {
            stopPolling();
            setMpesaRef(status.mpesaRef ?? null);
            setStep('success');
          } else if (status.status === 'FAILED') {
            stopPolling();
            setStep('failed');
            setError('Payment was declined or cancelled.');
          }
        } catch { /* keep polling */ }
      }, 3000);
    } catch (e: any) {
      setStep('failed');
      setError(e.message);
    }
  };

  const reset = () => { stopPolling(); setStep('idle'); setError(null); setMpesaRef(null); };

  useEffect(() => () => stopPolling(), []);

  return { step, error, mpesaRef, initiate, reset };
}

// ── WITHDRAW HOOK ─────────────────────────────────────────────────────────────

export function useWithdraw() {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const withdraw = async (amountKes: number, phone: string) => {
    setLoading(true);
    setError(null);
    setSuccess(false);
    try {
      await api.payments.withdraw(amountKes, phone);
      setSuccess(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return { loading, error, success, withdraw, reset: () => { setSuccess(false); setError(null); } };
}

// ── PORTFOLIO HOOKS ───────────────────────────────────────────────────────────

export function usePositions() {
  const { data, loading, error, refetch } = useAsync(() => api.portfolio.positions(), []);
  return { positions: data?.positions ?? [], loading, error, refetch };
}

export function useTransactions(page = 1) {
  const { data, loading, error, refetch } = useAsync(
    () => api.portfolio.transactions(page), [page]
  );
  return { transactions: data?.transactions ?? [], total: data?.total ?? 0, loading, error, refetch };
}

export function usePortfolioHistory(period: '7d' | '30d' | 'all') {
  const { data, loading, error, refetch } = useAsync(
    () => api.portfolio.history(period), [period]
  );
  return { history: data?.history ?? [], loading, error, refetch };
}

export function usePortfolioStats() {
  return useAsync(() => api.portfolio.stats(), []);
}

// ── LEADERBOARD HOOK ──────────────────────────────────────────────────────────

export function useLeaderboard(period: '7d' | '30d' | 'all', category?: Category) {
  const { data, loading, error, refetch } = useAsync(
    () => api.leaderboard.get(period, category), [period, category]
  );
  return {
    entries:  data?.entries  ?? [],
    myRank:   data?.myRank   ?? null,
    nextRank: data?.nextRank ?? null,
    loading, error, refetch,
  };
}

// ── REAL-TIME MARKET PRICE UPDATES (polling) ──────────────────────────────────

/**
 * Poll a single market for live price updates every N seconds.
 * Use this on the trading modal to keep prices fresh.
 */
export function useMarketLive(marketId: string, intervalMs = 5000) {
  const [market, setMarket] = useState<Market | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const { market: m } = await api.markets.get(marketId);
        if (active) setMarket(m);
      } catch { /* ignore */ }
    };
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => { active = false; clearInterval(id); };
  }, [marketId, intervalMs]);

  return market;
}
