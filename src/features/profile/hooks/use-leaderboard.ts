'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { getLeaderboardAction } from '../actions/stats-actions';
import { createCache, cacheKey } from '@/lib/utils/cache';
import type { LeaderboardEntry } from '../types';
import { leaderboardLogger } from '@/lib/utils/logger';

interface UseLeaderboardOptions {
  limit?: number;
  gameType?: string;
}

const leaderboardCache = createCache<LeaderboardEntry[]>({
  ttl: 5 * 60 * 1000, // 5 minutes
  maxSize: 20,
});

export function useLeaderboard({ limit = 10, gameType = 'tic-tac-toe' }: UseLeaderboardOptions = {}) {
  const key = cacheKey('leaderboard', gameType, limit);
  const cachedData = leaderboardCache.get(key);

  const [entries, setEntries] = useState<LeaderboardEntry[]>(cachedData || []);
  const [isLoading, setIsLoading] = useState(!cachedData);
  const [isRevalidating, setIsRevalidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLeaderboard = useCallback(
    async (forceRefresh = false) => {
      const currentKey = cacheKey('leaderboard', gameType, limit);

      if (!forceRefresh) {
        const cached = leaderboardCache.get(currentKey);
        if (cached) {
          setEntries(cached);
          setIsLoading(false);
          setIsRevalidating(true);
        }
      }

      if (!leaderboardCache.has(currentKey) || forceRefresh) {
        setIsLoading(true);
      }
      setError(null);

      try {
        const rows = await getLeaderboardAction(gameType, limit);
        const leaderboard: LeaderboardEntry[] = rows.map((row, index) => ({
          id: row.id,
          username: row.username || 'Jugador',
          avatarUrl: row.avatarUrl || undefined,
          gamesWon: row.gamesWon,
          gamesPlayed: row.gamesPlayed,
          winRate: row.gamesPlayed > 0 ? Math.round((row.gamesWon / row.gamesPlayed) * 100) : 0,
          rank: index + 1,
        }));
        leaderboardCache.set(currentKey, leaderboard);
        setEntries(leaderboard);
      } catch (err) {
        leaderboardLogger.error('Error fetching leaderboard:', err);
        setError('Error al cargar el ranking');
        if (!leaderboardCache.has(currentKey)) {
          setEntries([]);
        }
      } finally {
        setIsLoading(false);
        setIsRevalidating(false);
      }
    },
    [limit, gameType]
  );

  const refetch = useCallback(() => fetchLeaderboard(true), [fetchLeaderboard]);

  const fetchRef = useRef(fetchLeaderboard);
  fetchRef.current = fetchLeaderboard;

  useEffect(() => {
    fetchRef.current();
  }, [limit, gameType]);

  return { entries, isLoading, isRevalidating, error, refetch };
}

export function clearLeaderboardCache(): void {
  leaderboardCache.clear();
}

export default useLeaderboard;
