'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { GameResult, Stats } from '../types';
import { getStatsAction, syncStatsAction } from '../actions/stats-actions';
import { statsLogger } from '@/lib/utils/logger';

// Sync configuration
const SYNC_INTERVAL = 30 * 1000; // 30 seconds
const MAX_RETRY_ATTEMPTS = 3;
const BASE_RETRY_DELAY = 1000; // 1 second

interface StatsState {
  stats: Stats;
  recentGames: GameResult[];
  userId: string | null;
  isSyncing: boolean;
  isResetting: boolean;
  hasPendingChanges: boolean;
  lastSyncTime: number | null;

  // Actions
  recordGame: (result: Omit<GameResult, 'id' | 'createdAt'>) => void;
  resetStats: () => Promise<boolean>;
  setUserId: (userId: string | null) => void;
  loadFromSupabase: (userId: string) => Promise<void>;
  syncToSupabase: () => Promise<void>;
  startPeriodicSync: () => () => void;
}

const initialStats: Stats = {
  gamesPlayed: 0,
  gamesWon: 0,
  gamesLost: 0,
  gamesDraw: 0,
  winStreak: 0,
  bestWinStreak: 0,
  totalPlayTime: 0,
  byOpponent: {},
};

// Helper to delay for exponential backoff
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper to sync stats to the cloud (Prisma server action) with retry.
async function syncStatsToSupabase(
  _userId: string,
  stats: Stats,
  retryCount = 0
): Promise<boolean> {
  try {
    const ok = await syncStatsAction(stats, 'tic-tac-toe');
    if (!ok) throw new Error('Sync failed');
    return true;
  } catch (err) {
    statsLogger.error(`Error syncing stats (attempt ${retryCount + 1}):`, err);
    if (retryCount < MAX_RETRY_ATTEMPTS) {
      const backoffDelay = BASE_RETRY_DELAY * Math.pow(2, retryCount);
      await delay(backoffDelay);
      return syncStatsToSupabase(_userId, stats, retryCount + 1);
    }
    return false;
  }
}

// Helper to load stats from the cloud (Prisma server action).
async function loadStatsFromSupabase(_userId: string): Promise<Stats | null> {
  try {
    return await getStatsAction('tic-tac-toe');
  } catch (err) {
    statsLogger.error('Error loading stats:', err);
    return null;
  }
}

export const useStatsStore = create<StatsState>()(
  persist(
    (set, get) => ({
      stats: initialStats,
      recentGames: [],
      userId: null,
      isSyncing: false,
      isResetting: false,
      hasPendingChanges: false,
      lastSyncTime: null,

      setUserId: (userId) => {
        set({ userId });
        if (userId) {
          get().loadFromSupabase(userId);
        }
      },

      startPeriodicSync: () => {
        const intervalId = setInterval(() => {
          const { userId, hasPendingChanges, isSyncing } = get();
          if (userId && hasPendingChanges && !isSyncing) {
            get().syncToSupabase();
          }
        }, SYNC_INTERVAL);

        // Return cleanup function
        return () => clearInterval(intervalId);
      },

      loadFromSupabase: async (userId) => {
        set({ isSyncing: true });
        const cloudStats = await loadStatsFromSupabase(userId);

        if (cloudStats) {
          const localStats = get().stats;
          // Merge: use cloud if it has more games, otherwise sync local to cloud
          if (cloudStats.gamesPlayed >= localStats.gamesPlayed) {
            set({ stats: cloudStats, isSyncing: false });
          } else {
            // Local has more games, sync to cloud
            await syncStatsToSupabase(userId, localStats);
            set({ isSyncing: false });
          }
        } else {
          // No cloud stats, sync local to cloud if we have any
          const localStats = get().stats;
          if (localStats.gamesPlayed > 0) {
            await syncStatsToSupabase(userId, localStats);
          }
          set({ isSyncing: false });
        }
      },

      syncToSupabase: async () => {
        const { userId, stats, isSyncing } = get();
        if (!userId || isSyncing) return;

        set({ isSyncing: true });
        const success = await syncStatsToSupabase(userId, stats);

        set({
          isSyncing: false,
          hasPendingChanges: !success, // Keep pending if sync failed
          lastSyncTime: success ? Date.now() : get().lastSyncTime,
        });
      },

      recordGame: (gameResult) => {
        // Generate UUID - fallback for environments where crypto.randomUUID is not available
        const id = typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
        const createdAt = new Date().toISOString();
        const fullResult: GameResult = { ...gameResult, id, createdAt };

        // Calculate new stats and capture them for sync
        let newStatsForSync: Stats | null = null;

        set((state) => {
          const newStats = { ...state.stats };

          // Update general stats
          newStats.gamesPlayed += 1;
          newStats.totalPlayTime += gameResult.durationSeconds;

          if (gameResult.result === 'win') {
            newStats.gamesWon += 1;
            newStats.winStreak += 1;
            if (newStats.winStreak > newStats.bestWinStreak) {
              newStats.bestWinStreak = newStats.winStreak;
            }
          } else if (gameResult.result === 'loss') {
            newStats.gamesLost += 1;
            newStats.winStreak = 0;
          } else {
            newStats.gamesDraw += 1;
            // Draw doesn't reset win streak
          }

          // Update by opponent stats
          const opponent = gameResult.opponentType;
          if (!newStats.byOpponent[opponent]) {
            newStats.byOpponent[opponent] = { played: 0, won: 0, lost: 0, draw: 0 };
          }
          newStats.byOpponent[opponent].played += 1;
          if (gameResult.result === 'win') {
            newStats.byOpponent[opponent].won += 1;
          } else if (gameResult.result === 'loss') {
            newStats.byOpponent[opponent].lost += 1;
          } else {
            newStats.byOpponent[opponent].draw += 1;
          }

          // Keep only last 50 games
          const recentGames = [fullResult, ...state.recentGames].slice(0, 50);

          // Capture stats for sync (avoid race condition with get())
          newStatsForSync = newStats;

          return { stats: newStats, recentGames, hasPendingChanges: true };
        });

        // Sync to Supabase using captured stats (not get() which could have changed)
        const { userId } = get();
        if (userId && newStatsForSync) {
          syncStatsToSupabase(userId, newStatsForSync);
        }
      },

      resetStats: async () => {
        const { userId, isResetting } = get();

        // Prevent double reset
        if (isResetting) return false;

        set({ isResetting: true, stats: initialStats, recentGames: [], hasPendingChanges: false });

        // Also reset in Supabase
        if (userId) {
          try {
            const success = await syncStatsToSupabase(userId, initialStats);
            set({ isResetting: false });
            return success;
          } catch (err) {
            statsLogger.error('Error resetting stats in Supabase:', err);
            set({ isResetting: false });
            return false;
          }
        }

        set({ isResetting: false });
        return true;
      },
    }),
    {
      name: 'el-rincon-stats',
      partialize: (state) => ({
        stats: state.stats,
        recentGames: state.recentGames,
        hasPendingChanges: state.hasPendingChanges,
        lastSyncTime: state.lastSyncTime,
      }),
      // Handle localStorage errors (quota exceeded, private browsing, etc.)
      onRehydrateStorage: () => {
        return (_state, error) => {
          if (error) {
            statsLogger.warn('Error rehydrating stats from localStorage:', error);
            // State will use initialStats as fallback
          }
        };
      },
      // Gracefully handle storage errors (with SSR check)
      storage: {
        getItem: (name) => {
          if (typeof window === 'undefined') return null;
          try {
            const value = localStorage.getItem(name);
            return value ? JSON.parse(value) : null;
          } catch (error) {
            statsLogger.warn('Error reading from localStorage:', error);
            return null;
          }
        },
        setItem: (name, value) => {
          if (typeof window === 'undefined') return;
          try {
            localStorage.setItem(name, JSON.stringify(value));
          } catch (error) {
            statsLogger.warn('Error writing to localStorage:', error);
            // Silently fail - stats will still work in memory
          }
        },
        removeItem: (name) => {
          if (typeof window === 'undefined') return;
          try {
            localStorage.removeItem(name);
          } catch (error) {
            statsLogger.warn('Error removing from localStorage:', error);
          }
        },
      },
    }
  )
);

// Memoized selectors - use these to prevent unnecessary re-renders
export const useStats = () => useStatsStore((state) => state.stats);
export const useRecentGames = () => useStatsStore((state) => state.recentGames);
export const useStatsUserId = () => useStatsStore((state) => state.userId);
export const useStatsSyncing = () => useStatsStore((state) => state.isSyncing);
export const useStatsHasPendingChanges = () => useStatsStore((state) => state.hasPendingChanges);
export const useStatsActions = () => useStatsStore((state) => ({
  recordGame: state.recordGame,
  resetStats: state.resetStats,
  setUserId: state.setUserId,
  loadFromSupabase: state.loadFromSupabase,
  syncToSupabase: state.syncToSupabase,
  startPeriodicSync: state.startPeriodicSync,
}));

// Helper functions
export function getWinRate(stats: Stats): number {
  if (stats.gamesPlayed === 0) return 0;
  return Math.round((stats.gamesWon / stats.gamesPlayed) * 100);
}

export function formatPlayTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
