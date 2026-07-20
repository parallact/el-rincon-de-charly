'use server';

import { Prisma } from '@/generated/prisma';
import { prisma } from '@/lib/prisma';
import { getUserId } from '@/lib/auth-helpers';

// Serializable wallet / transaction shapes (snake_case) matching the legacy
// Supabase rows the client store expects.
export interface WalletDTO {
  id: string;
  user_id: string;
  balance: number;
  created_at: string;
  updated_at: string;
}

export interface WalletTransactionDTO {
  id: string;
  wallet_id: string;
  type: string;
  amount: number;
  balance_after: number;
  description: string | null;
  game_slug: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

type WalletRow = Prisma.WalletGetPayload<object>;
type TxRow = Prisma.WalletTransactionGetPayload<object>;

function mapWallet(w: WalletRow): WalletDTO {
  return {
    id: w.id,
    user_id: w.userId,
    balance: Number(w.balance),
    created_at: w.createdAt.toISOString(),
    updated_at: w.updatedAt.toISOString(),
  };
}

function mapTx(t: TxRow): WalletTransactionDTO {
  return {
    id: t.id,
    wallet_id: t.walletId,
    type: t.type,
    amount: Number(t.amount),
    balance_after: Number(t.balanceAfter),
    description: t.description,
    game_slug: t.gameSlug,
    metadata: (t.metadata as Record<string, unknown> | null) ?? {},
    created_at: t.createdAt.toISOString(),
  };
}

export interface WalletResult {
  wallet: WalletDTO | null;
  error: string | null;
}

// Ensure the caller has a wallet (starting balance), returning it.
export async function ensureWalletAction(): Promise<WalletDTO | null> {
  const userId = await getUserId();
  if (!userId) return null;
  const wallet = await prisma.wallet.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
  return mapWallet(wallet);
}

export async function getTransactionsAction(
  limit = 20,
  before?: string
): Promise<{ transactions: WalletTransactionDTO[]; hasMore: boolean }> {
  const userId = await getUserId();
  if (!userId) return { transactions: [], hasMore: false };
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: { id: true } });
  if (!wallet) return { transactions: [], hasMore: false };

  const rows = await prisma.walletTransaction.findMany({
    where: { walletId: wallet.id, ...(before ? { createdAt: { lt: new Date(before) } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  return { transactions: rows.slice(0, limit).map(mapTx), hasMore };
}

// NOTE: there is deliberately no client-callable "debit an arbitrary bet" action.
// PvP stakes are debited server-side and atomically at the moment both players
// commit to an agreed amount (see debitAgreedStakes + the game-room actions), so a
// client cannot reach a paid-out game while skipping its own debit.

// Generic credit helper (win / bonus / refund).
async function credit(
  userId: string,
  amount: number,
  type: string,
  description: string,
  gameSlug?: string
): Promise<WalletDTO> {
  return prisma.$transaction(async (tx) => {
    const w = await tx.wallet.update({
      where: { userId },
      data: { balance: { increment: new Prisma.Decimal(amount) }, updatedAt: new Date() },
    });
    await tx.walletTransaction.create({
      data: {
        walletId: w.id,
        type,
        amount: new Prisma.Decimal(amount),
        balanceAfter: w.balance,
        description,
        ...(gameSlug ? { gameSlug } : {}),
      },
    });
    return mapWallet(w);
  });
}

// Settle a finished bet game from the server-authoritative stake ledger, once per
// player. The payout is computed from the SUM of confirmed BetStake rows — never
// from client-supplied room metadata — and capped at the total staked, so no more
// money can ever leave settlement than actually entered it.
export async function settleBetAction(roomId: string): Promise<WalletResult> {
  const userId = await getUserId();
  if (!userId) return { wallet: null, error: 'No autenticado' };

  const room = await prisma.gameRoom.findUnique({ where: { id: roomId } });
  if (!room) return { wallet: null, error: 'Sala no encontrada' };
  if (room.status !== 'finished') return { wallet: null, error: 'La partida no terminó' };
  if (room.player1Id !== userId && room.player2Id !== userId) {
    return { wallet: null, error: 'No sos participante' };
  }

  const current = await prisma.wallet.findUnique({ where: { userId } });
  if (!current) return { wallet: null, error: 'Billetera no encontrada' };

  // Authoritative stake ledger for this room.
  const stakes = await prisma.betStake.findMany({ where: { roomId } });
  if (stakes.length === 0) return { wallet: mapWallet(current), error: null }; // no real bet
  const myStake = stakes.find((s) => s.userId === userId) ?? null;
  const totalStaked = stakes.reduce((sum, s) => sum + Number(s.amount), 0);

  // Idempotency: one settlement per (room, player).
  try {
    await prisma.betSettlement.create({ data: { roomId, userId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { wallet: mapWallet(current), error: null }; // already settled
    }
    throw err;
  }

  let payout = 0;
  let type = 'win';
  let description = 'Victoria en partida con apuesta';
  if (room.isDraw) {
    // Refund each player exactly their own recorded stake.
    payout = myStake ? Number(myStake.amount) : 0;
    type = 'refund';
    description = 'Reembolso por empate';
  } else if (room.winnerId === userId) {
    // Winner takes the whole pot (capped at what was actually staked).
    payout = totalStaked;
  }

  if (payout <= 0) return { wallet: mapWallet(current), error: null };
  const wallet = await credit(userId, payout, type, description, room.gameType);
  if (myStake) {
    await prisma.betStake.updateMany({ where: { roomId, userId }, data: { settled: true } });
  }
  return { wallet, error: null };
}

// Refund the caller's own recorded stake when leaving an unfinished room
// (idempotent — shares the per-(room, player) settlement key).
export async function cancelBetAction(roomId: string): Promise<WalletResult> {
  const userId = await getUserId();
  if (!userId) return { wallet: null, error: 'No autenticado' };
  const room = await prisma.gameRoom.findUnique({ where: { id: roomId } });
  if (!room) return { wallet: null, error: 'Sala no encontrada' };
  if (room.status === 'finished') return { wallet: null, error: 'La partida ya terminó' };
  if (room.player1Id !== userId && room.player2Id !== userId) {
    return { wallet: null, error: 'No sos participante' };
  }
  const current = await prisma.wallet.findUnique({ where: { userId } });
  if (!current) return { wallet: null, error: 'Billetera no encontrada' };

  const myStake = await prisma.betStake.findUnique({
    where: { roomId_userId: { roomId, userId } },
  });
  if (!myStake || myStake.settled) return { wallet: mapWallet(current), error: null };

  // Idempotency shares the settlement key so a stake is refunded at most once.
  try {
    await prisma.betSettlement.create({ data: { roomId, userId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { wallet: mapWallet(current), error: null };
    }
    throw err;
  }
  const wallet = await credit(userId, Number(myStake.amount), 'refund', 'Reembolso por cancelar', room.gameType);
  await prisma.betStake.updateMany({ where: { roomId, userId }, data: { settled: true } });
  return { wallet, error: null };
}

// The AR-local (America/Argentina/Buenos_Aires, UTC-3, no DST) calendar day as
// "YYYY-MM-DD". Used as the daily-bonus idempotency key so "once per day" matches
// the user's wall clock rather than a rolling 24h window.
function argentinaDateKey(now = new Date()): string {
  // Buenos Aires is a fixed UTC-3 offset year-round.
  const local = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

// Daily bonus, server-enforced to once per AR-local day.
//
// The unique (userId, bonusDate) ledger row turns the previous check-then-act
// (findFirst → credit) into a single atomic insert: two concurrent claims race to
// create the same row, the loser hits the primary-key constraint (P2002), and its
// crediting transaction never runs — so the bonus can be credited at most once.
export async function claimDailyBonusAction(): Promise<WalletResult> {
  const userId = await getUserId();
  if (!userId) return { wallet: null, error: 'No autenticado' };
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) return { wallet: null, error: 'Billetera no encontrada' };

  const bonusDate = argentinaDateKey();
  try {
    const updated = await prisma.$transaction(async (tx) => {
      // Claim the day first; a duplicate throws P2002 and aborts before crediting.
      await tx.dailyBonus.create({ data: { userId, bonusDate } });
      const w = await tx.wallet.update({
        where: { userId },
        data: { balance: { increment: new Prisma.Decimal(1000) }, updatedAt: new Date() },
      });
      await tx.walletTransaction.create({
        data: {
          walletId: w.id,
          type: 'bonus',
          amount: new Prisma.Decimal(1000),
          balanceAfter: w.balance,
          description: 'Bonificacion diaria',
        },
      });
      return mapWallet(w);
    });
    return { wallet: updated, error: null };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { wallet: mapWallet(wallet), error: 'Ya reclamaste el bono diario' };
    }
    throw err;
  }
}

// NOTE: single-player Plinko wins are settled atomically and server-side by
// dropPlinkoBallAction (provably fair). There is deliberately no generic
// "credit an arbitrary win" action — that would let a client assert any payout.
