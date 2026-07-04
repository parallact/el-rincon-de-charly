'use client';

import { create } from 'zustand';
import { getClient } from '@/lib/supabase/client';
import type { Wallet, WalletTransaction, WalletRow, WalletTransactionRow } from '../types';
import { validateWalletRow, validateWalletTransactionRows } from '@/lib/validators/database-rows';
import { walletLogger } from '@/lib/utils/logger';

interface WalletState {
  wallet: Wallet | null;
  transactions: WalletTransaction[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMoreTransactions: boolean;
  error: string | null;

  // Actions
  loadWallet: (userId: string) => Promise<void>;
  loadTransactions: (limit?: number) => Promise<void>;
  loadMoreTransactions: (limit?: number) => Promise<void>;
  // Mutations — all balance changes go through server-side (SECURITY DEFINER) RPCs.
  placeBet: (amount: number, gameSlug: string, description?: string) => Promise<boolean>;
  settleBet: (roomId: string) => Promise<boolean>;
  cancelBet: (roomId: string) => Promise<boolean>;
  claimDailyBonus: () => Promise<boolean>;
  // Single-player win credit (Plinko). NOTE: the amount is client-asserted — see
  // wallet_credit in migration 010 for why and the provably-fair follow-up.
  creditWin: (amount: number, gameSlug: string, description?: string) => Promise<boolean>;
  reset: () => void;
}

// Convert DB row to Wallet
function rowToWallet(row: WalletRow): Wallet {
  return {
    id: row.id,
    userId: row.user_id,
    balance: Number(row.balance),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Convert DB row to WalletTransaction
function rowToTransaction(row: WalletTransactionRow): WalletTransaction {
  return {
    id: row.id,
    walletId: row.wallet_id,
    type: row.type,
    amount: Number(row.amount),
    balanceAfter: Number(row.balance_after),
    description: row.description || undefined,
    gameSlug: row.game_slug || undefined,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

// Track pending mutations to prevent overlapping wallet operations.
const pendingOperations = new Set<string>();

// Prevent duplicate loadWallet calls (race condition fix)
let walletLoadPromise: Promise<void> | null = null;
let walletLoadUserId: string | null = null;

const MAX_LOCK_WAIT_MS = 5000;
const LOCK_CHECK_INTERVAL_MS = 50;

function generateOperationId(type: string): string {
  return `${type}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

async function withWalletLock<T>(operationType: string, operation: () => Promise<T>): Promise<T> {
  const operationId = generateOperationId(operationType);
  const startTime = Date.now();

  while (pendingOperations.size > 0) {
    if (Date.now() - startTime > MAX_LOCK_WAIT_MS) {
      walletLogger.error('[Wallet] Lock timeout, pending ops:', Array.from(pendingOperations));
      throw new Error('Wallet operation timeout - another operation is taking too long');
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_CHECK_INTERVAL_MS));
  }

  pendingOperations.add(operationId);
  try {
    return await operation();
  } finally {
    pendingOperations.delete(operationId);
  }
}

// Call a wallet mutation RPC and sync local state from the returned wallet row.
// The server validates the transition and updates balance + ledger atomically;
// the client never writes the balance directly.
async function callWalletRpc(
  fn:
    | 'wallet_place_bet'
    | 'wallet_settle_bet'
    | 'wallet_cancel_bet'
    | 'wallet_claim_daily_bonus'
    | 'wallet_credit'
    | 'wallet_ensure',
  args: Record<string, unknown>,
  set: (state: Partial<WalletState>) => void,
  errorMessage: string
): Promise<boolean> {
  const supabase = getClient();
  try {
    // @ts-expect-error - Supabase RPC types require CLI regeneration (supabase gen types)
    const { data, error } = await supabase.rpc(fn, args);
    if (error || !data) {
      // Surface the server's validation message (e.g. insufficient balance) when present.
      set({ error: error?.message || errorMessage });
      return false;
    }
    set({ wallet: rowToWallet(validateWalletRow(data, fn)), error: null });
    return true;
  } catch (err) {
    walletLogger.error(`Error in wallet RPC (${fn}):`, err);
    set({ error: errorMessage });
    return false;
  }
}

const TRANSACTIONS_PAGE_SIZE = 20;

export const useWalletStore = create<WalletState>((set, get) => ({
  wallet: null,
  transactions: [],
  isLoading: false,
  isLoadingMore: false,
  hasMoreTransactions: true,
  error: null,

  loadWallet: async (userId) => {
    if (walletLoadPromise && walletLoadUserId === userId) {
      await walletLoadPromise;
      return;
    }

    const currentWallet = get().wallet;
    if (currentWallet && currentWallet.userId === userId && !get().error) {
      return;
    }

    set({ isLoading: true, error: null });

    walletLoadUserId = userId;
    walletLoadPromise = (async () => {
      const supabase = getClient();

      try {
        const { data, error } = await supabase
          .from('wallets')
          .select('*')
          .eq('user_id', userId)
          .maybeSingle();

        if (error) throw error;

        if (data) {
          set({ wallet: rowToWallet(validateWalletRow(data, 'loadWallet')), isLoading: false });
          return;
        }

        // No wallet yet — create it server-side (validated starting balance).
        // @ts-expect-error - Supabase RPC types require CLI regeneration (supabase gen types)
        const { data: ensured, error: ensureError } = await supabase.rpc('wallet_ensure', {});
        if (ensureError || !ensured) {
          walletLogger.error('Error ensuring wallet:', ensureError);
          set({ error: 'Error al crear la billetera', isLoading: false });
          return;
        }
        set({ wallet: rowToWallet(validateWalletRow(ensured, 'wallet_ensure')), isLoading: false });
      } catch (err) {
        walletLogger.error('Error loading wallet:', err);
        set({ error: 'Error al cargar la billetera', isLoading: false });
      } finally {
        walletLoadPromise = null;
        walletLoadUserId = null;
      }
    })();

    await walletLoadPromise;
  },

  loadTransactions: async (limit = TRANSACTIONS_PAGE_SIZE) => {
    const { wallet } = get();
    if (!wallet) return;

    const supabase = getClient();

    try {
      const { data, error } = await supabase
        .from('wallet_transactions')
        .select('*')
        .eq('wallet_id', wallet.id)
        .order('created_at', { ascending: false })
        .limit(limit + 1);

      if (error) throw error;

      if (data) {
        const hasMore = data.length > limit;
        const validatedRows = validateWalletTransactionRows(data.slice(0, limit));
        const transactions = validatedRows.map(rowToTransaction);
        set({ transactions, hasMoreTransactions: hasMore });
      }
    } catch (err) {
      walletLogger.error('Error loading transactions:', err);
    }
  },

  loadMoreTransactions: async (limit = TRANSACTIONS_PAGE_SIZE) => {
    const { wallet, transactions, isLoadingMore, hasMoreTransactions } = get();
    if (!wallet || isLoadingMore || !hasMoreTransactions) return;

    set({ isLoadingMore: true });
    const supabase = getClient();

    try {
      const lastTransaction = transactions[transactions.length - 1];
      if (!lastTransaction) {
        set({ isLoadingMore: false, hasMoreTransactions: false });
        return;
      }

      const { data, error } = await supabase
        .from('wallet_transactions')
        .select('*')
        .eq('wallet_id', wallet.id)
        .lt('created_at', lastTransaction.createdAt)
        .order('created_at', { ascending: false })
        .limit(limit + 1);

      if (error) throw error;

      if (data) {
        const hasMore = data.length > limit;
        const validatedRows = validateWalletTransactionRows(data.slice(0, limit));
        const newTransactions = validatedRows.map(rowToTransaction);
        set({
          transactions: [...transactions, ...newTransactions],
          hasMoreTransactions: hasMore,
          isLoadingMore: false,
        });
      }
    } catch (err) {
      walletLogger.error('Error loading more transactions:', err);
      set({ isLoadingMore: false });
    }
  },

  placeBet: async (amount, gameSlug, description) => {
    return withWalletLock('placeBet', async () => {
      if (!get().wallet) {
        set({ error: 'Billetera no cargada' });
        return false;
      }
      return callWalletRpc(
        'wallet_place_bet',
        { p_amount: amount, p_game_slug: gameSlug, p_description: description ?? null },
        set,
        'Error al realizar la apuesta'
      );
    });
  },

  // Settle a finished bet game from the authoritative room result (server pays
  // out the pot / refunds a draw at most once per player).
  settleBet: async (roomId) => {
    return withWalletLock('settleBet', async () => {
      if (!get().wallet) {
        set({ error: 'Billetera no cargada' });
        return false;
      }
      return callWalletRpc('wallet_settle_bet', { p_room_id: roomId }, set, 'Error al liquidar la apuesta');
    });
  },

  // Refund a placed bet when leaving an unfinished room.
  cancelBet: async (roomId) => {
    return withWalletLock('cancelBet', async () => {
      if (!get().wallet) {
        set({ error: 'Billetera no cargada' });
        return false;
      }
      return callWalletRpc('wallet_cancel_bet', { p_room_id: roomId }, set, 'Error al reembolsar la apuesta');
    });
  },

  claimDailyBonus: async () => {
    return withWalletLock('claimDailyBonus', async () => {
      if (!get().wallet) {
        set({ error: 'Billetera no cargada. Intenta recargar la página.' });
        return false;
      }
      return callWalletRpc('wallet_claim_daily_bonus', {}, set, 'Error al reclamar el bono diario');
    });
  },

  creditWin: async (amount, gameSlug, description) => {
    return withWalletLock('creditWin', async () => {
      if (!get().wallet) {
        set({ error: 'Billetera no cargada' });
        return false;
      }
      return callWalletRpc(
        'wallet_credit',
        { p_amount: amount, p_game_slug: gameSlug, p_description: description ?? null },
        set,
        'Error al registrar la ganancia'
      );
    });
  },

  reset: () => {
    set({
      wallet: null,
      transactions: [],
      isLoading: false,
      isLoadingMore: false,
      hasMoreTransactions: true,
      error: null,
    });
  },
}));

// Memoized selectors - use these to prevent unnecessary re-renders
export const useWallet = () => useWalletStore((state) => state.wallet);
export const useWalletBalance = () => useWalletStore((state) => state.wallet?.balance ?? 0);
export const useWalletTransactions = () => useWalletStore((state) => state.transactions);
export const useWalletLoading = () => useWalletStore((state) => state.isLoading);
export const useWalletError = () => useWalletStore((state) => state.error);
export const useWalletActions = () =>
  useWalletStore((state) => ({
    loadWallet: state.loadWallet,
    loadTransactions: state.loadTransactions,
    loadMoreTransactions: state.loadMoreTransactions,
    placeBet: state.placeBet,
    settleBet: state.settleBet,
    cancelBet: state.cancelBet,
    claimDailyBonus: state.claimDailyBonus,
    creditWin: state.creditWin,
    reset: state.reset,
  }));

// Format balance for display
export function formatBalance(balance: number): string {
  return new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(balance);
}
