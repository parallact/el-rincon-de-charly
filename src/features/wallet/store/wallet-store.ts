'use client';

import { create } from 'zustand';
import type { Wallet, WalletTransaction } from '../types';
import { walletLogger } from '@/lib/utils/logger';
import {
  ensureWalletAction,
  getTransactionsAction,
  placeBetAction,
  settleBetAction,
  cancelBetAction,
  claimDailyBonusAction,
  type WalletDTO,
  type WalletTransactionDTO,
} from '../actions/wallet-actions';

interface WalletState {
  wallet: Wallet | null;
  transactions: WalletTransaction[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMoreTransactions: boolean;
  error: string | null;

  loadWallet: (userId: string) => Promise<void>;
  loadTransactions: (limit?: number) => Promise<void>;
  loadMoreTransactions: (limit?: number) => Promise<void>;
  placeBet: (amount: number, gameSlug: string, description?: string) => Promise<boolean>;
  settleBet: (roomId: string) => Promise<boolean>;
  cancelBet: (roomId: string) => Promise<boolean>;
  claimDailyBonus: () => Promise<boolean>;
  // Replace the wallet from a server-authoritative DTO (e.g. after a Plinko drop
  // that already debited the bet and credited the win in one atomic action).
  setWallet: (dto: WalletDTO) => void;
  reset: () => void;
}

function dtoToWallet(dto: WalletDTO): Wallet {
  return {
    id: dto.id,
    userId: dto.user_id,
    balance: dto.balance,
    createdAt: dto.created_at,
    updatedAt: dto.updated_at,
  };
}

function dtoToTransaction(dto: WalletTransactionDTO): WalletTransaction {
  return {
    id: dto.id,
    walletId: dto.wallet_id,
    type: dto.type as WalletTransaction['type'],
    amount: dto.amount,
    balanceAfter: dto.balance_after,
    description: dto.description || undefined,
    gameSlug: dto.game_slug || undefined,
    metadata: dto.metadata,
    createdAt: dto.created_at,
  };
}

// Serialize wallet mutations client-side (the server validates too).
const pendingOperations = new Set<string>();
const MAX_LOCK_WAIT_MS = 5000;
const LOCK_CHECK_INTERVAL_MS = 50;

async function withWalletLock<T>(op: () => Promise<T>): Promise<T> {
  const start = Date.now();
  while (pendingOperations.size > 0) {
    if (Date.now() - start > MAX_LOCK_WAIT_MS) {
      throw new Error('Wallet operation timeout');
    }
    await new Promise((r) => setTimeout(r, LOCK_CHECK_INTERVAL_MS));
  }
  const key = String(Date.now()) + Math.random();
  pendingOperations.add(key);
  try {
    return await op();
  } finally {
    pendingOperations.delete(key);
  }
}

const TRANSACTIONS_PAGE_SIZE = 20;

// Duplicate load guard.
let walletLoadPromise: Promise<void> | null = null;
let walletLoadUserId: string | null = null;

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
    const current = get().wallet;
    if (current && current.userId === userId && !get().error) return;

    set({ isLoading: true, error: null });
    walletLoadUserId = userId;
    walletLoadPromise = (async () => {
      try {
        const dto = await ensureWalletAction();
        if (dto) set({ wallet: dtoToWallet(dto), isLoading: false });
        else set({ error: 'Error al cargar la billetera', isLoading: false });
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
    if (!get().wallet) return;
    try {
      const { transactions, hasMore } = await getTransactionsAction(limit);
      set({ transactions: transactions.map(dtoToTransaction), hasMoreTransactions: hasMore });
    } catch (err) {
      walletLogger.error('Error loading transactions:', err);
    }
  },

  loadMoreTransactions: async (limit = TRANSACTIONS_PAGE_SIZE) => {
    const { wallet, transactions, isLoadingMore, hasMoreTransactions } = get();
    if (!wallet || isLoadingMore || !hasMoreTransactions) return;
    const last = transactions[transactions.length - 1];
    if (!last) {
      set({ hasMoreTransactions: false });
      return;
    }
    set({ isLoadingMore: true });
    try {
      const { transactions: more, hasMore } = await getTransactionsAction(limit, last.createdAt);
      set({
        transactions: [...transactions, ...more.map(dtoToTransaction)],
        hasMoreTransactions: hasMore,
        isLoadingMore: false,
      });
    } catch (err) {
      walletLogger.error('Error loading more transactions:', err);
      set({ isLoadingMore: false });
    }
  },

  placeBet: (amount, gameSlug, description) =>
    withWalletLock(async () => {
      set({ error: null });
      const { wallet, error } = await placeBetAction(amount, gameSlug, description);
      if (wallet) {
        set({ wallet: dtoToWallet(wallet) });
        return true;
      }
      set({ error: error ?? 'Error al realizar la apuesta' });
      return false;
    }),

  settleBet: (roomId) =>
    withWalletLock(async () => {
      const { wallet, error } = await settleBetAction(roomId);
      if (wallet) {
        set({ wallet: dtoToWallet(wallet), error: null });
        return true;
      }
      set({ error: error ?? 'Error al liquidar la apuesta' });
      return false;
    }),

  cancelBet: (roomId) =>
    withWalletLock(async () => {
      const { wallet, error } = await cancelBetAction(roomId);
      if (wallet) {
        set({ wallet: dtoToWallet(wallet), error: null });
        return true;
      }
      set({ error: error ?? 'Error al reembolsar la apuesta' });
      return false;
    }),

  claimDailyBonus: () =>
    withWalletLock(async () => {
      const { wallet, error } = await claimDailyBonusAction();
      if (wallet && !error) {
        set({ wallet: dtoToWallet(wallet), error: null });
        return true;
      }
      set({ error: error ?? 'Error al reclamar el bono diario' });
      return false;
    }),

  setWallet: (dto) => set({ wallet: dtoToWallet(dto), error: null }),

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
    setWallet: state.setWallet,
    reset: state.reset,
  }));

export function formatBalance(balance: number): string {
  return new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(balance);
}
