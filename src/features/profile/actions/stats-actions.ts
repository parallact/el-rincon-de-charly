'use server';

import { Prisma } from '@/generated/prisma';
import { prisma } from '@/lib/prisma';
import { getUserId } from '@/lib/auth-helpers';

export interface StatsDTO {
  gamesPlayed: number;
  gamesWon: number;
  gamesLost: number;
  gamesDraw: number;
  winStreak: number;
  bestWinStreak: number;
  totalPlayTime: number;
  byOpponent: Record<string, { played: number; won: number; lost: number; draw: number }>;
}

export interface LeaderboardEntryDTO {
  id: string;
  username: string | null;
  avatarUrl: string | null;
  gamesWon: number;
  gamesPlayed: number;
}

export async function getStatsAction(gameType = 'tic-tac-toe'): Promise<StatsDTO | null> {
  const userId = await getUserId();
  if (!userId) return null;
  const row = await prisma.gameStats.findUnique({
    where: { userId_gameType: { userId, gameType } },
  });
  if (!row) return null;
  return {
    gamesPlayed: row.gamesPlayed,
    gamesWon: row.gamesWon,
    gamesLost: row.gamesLost,
    gamesDraw: row.gamesDraw,
    winStreak: row.winStreak,
    bestWinStreak: row.bestWinStreak,
    totalPlayTime: row.totalPlayTime,
    byOpponent: (row.byOpponent as StatsDTO['byOpponent'] | null) ?? {},
  };
}

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

// Validate a client-supplied stats payload before persisting it. The client is
// the source of truth for its own game outcomes, but a forged payload must not be
// able to inflate the (public) leaderboard: counters must be sane non-negative
// integers that add up, streaks must be consistent, and cumulative counters may
// only grow relative to what we already persisted.
async function statsPayloadIsValid(
  userId: string,
  gameType: string,
  stats: StatsDTO
): Promise<boolean> {
  const counters = [
    stats.gamesPlayed,
    stats.gamesWon,
    stats.gamesLost,
    stats.gamesDraw,
    stats.winStreak,
    stats.bestWinStreak,
    stats.totalPlayTime,
  ];
  if (!counters.every(isNonNegativeInt)) return false;
  if (stats.gamesWon + stats.gamesLost + stats.gamesDraw !== stats.gamesPlayed) return false;
  if (stats.bestWinStreak < stats.winStreak) return false;
  if (
    stats.byOpponent === null ||
    typeof stats.byOpponent !== 'object' ||
    Array.isArray(stats.byOpponent)
  ) {
    return false;
  }

  // Cumulative counters are monotonic non-decreasing. (winStreak is excluded —
  // the current streak legitimately resets to 0 on a loss.)
  const existing = await prisma.gameStats.findUnique({
    where: { userId_gameType: { userId, gameType } },
  });
  if (existing) {
    if (
      stats.gamesPlayed < existing.gamesPlayed ||
      stats.gamesWon < existing.gamesWon ||
      stats.gamesLost < existing.gamesLost ||
      stats.gamesDraw < existing.gamesDraw ||
      stats.bestWinStreak < existing.bestWinStreak ||
      stats.totalPlayTime < existing.totalPlayTime
    ) {
      return false;
    }
  }
  return true;
}

export async function syncStatsAction(stats: StatsDTO, gameType = 'tic-tac-toe'): Promise<boolean> {
  const userId = await getUserId();
  if (!userId) return false;
  if (!(await statsPayloadIsValid(userId, gameType, stats))) return false;
  const data = {
    gamesPlayed: stats.gamesPlayed,
    gamesWon: stats.gamesWon,
    gamesLost: stats.gamesLost,
    gamesDraw: stats.gamesDraw,
    winStreak: stats.winStreak,
    bestWinStreak: stats.bestWinStreak,
    totalPlayTime: stats.totalPlayTime,
    byOpponent: (stats.byOpponent ?? {}) as Prisma.InputJsonValue,
  };
  try {
    await prisma.gameStats.upsert({
      where: { userId_gameType: { userId, gameType } },
      create: { userId, gameType, ...data },
      update: data,
    });
    return true;
  } catch {
    return false;
  }
}

export async function getLeaderboardAction(
  gameType = 'tic-tac-toe',
  limit = 10
): Promise<LeaderboardEntryDTO[]> {
  const rows = await prisma.gameStats.findMany({
    where: { gameType },
    orderBy: { gamesWon: 'desc' },
    take: limit,
    include: { user: { select: { id: true, username: true, avatarUrl: true } } },
  });
  return rows.map((r) => ({
    id: r.user.id,
    username: r.user.username,
    avatarUrl: r.user.avatarUrl,
    gamesWon: r.gamesWon,
    gamesPlayed: r.gamesPlayed,
  }));
}
