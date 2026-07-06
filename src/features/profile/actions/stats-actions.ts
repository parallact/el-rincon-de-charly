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

export async function syncStatsAction(stats: StatsDTO, gameType = 'tic-tac-toe'): Promise<boolean> {
  const userId = await getUserId();
  if (!userId) return false;
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
