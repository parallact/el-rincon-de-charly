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

// Debit a validated bet from the caller's wallet (atomic: the conditional
// decrement fails if the balance is insufficient).
export async function placeBetAction(
  amount: number,
  gameSlug: string,
  description?: string
): Promise<WalletResult> {
  const userId = await getUserId();
  if (!userId) return { wallet: null, error: 'No autenticado' };
  if (!(amount > 0)) return { wallet: null, error: 'Monto inválido' };

  try {
    const wallet = await prisma.$transaction(async (tx) => {
      const res = await tx.wallet.updateMany({
        where: { userId, balance: { gte: new Prisma.Decimal(amount) } },
        data: { balance: { decrement: new Prisma.Decimal(amount) }, updatedAt: new Date() },
      });
      if (res.count === 0) throw new Error('Saldo insuficiente');
      const w = await tx.wallet.findUniqueOrThrow({ where: { userId } });
      await tx.walletTransaction.create({
        data: {
          walletId: w.id,
          type: 'bet',
          amount: new Prisma.Decimal(-amount),
          balanceAfter: w.balance,
          description: description ?? 'Apuesta',
          gameSlug,
        },
      });
      return w;
    });
    return { wallet: mapWallet(wallet), error: null };
  } catch (err) {
    return { wallet: null, error: err instanceof Error ? err.message : 'Error al apostar' };
  }
}

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

// Settle a finished bet game from the authoritative room state, once per player.
export async function settleBetAction(roomId: string): Promise<WalletResult> {
  const userId = await getUserId();
  if (!userId) return { wallet: null, error: 'No autenticado' };

  const room = await prisma.gameRoom.findUnique({ where: { id: roomId } });
  if (!room) return { wallet: null, error: 'Sala no encontrada' };
  if (room.status !== 'finished') return { wallet: null, error: 'La partida no terminó' };
  if (room.player1Id !== userId && room.player2Id !== userId) {
    return { wallet: null, error: 'No sos participante' };
  }
  const bet = Number((room.metadata as Record<string, unknown> | null)?.bet_amount ?? 0);

  const current = await prisma.wallet.findUnique({ where: { userId } });
  if (!current) return { wallet: null, error: 'Billetera no encontrada' };
  if (!(bet > 0)) return { wallet: mapWallet(current), error: null };

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
  if (room.isDraw) payout = bet;
  else if (room.winnerId === userId) payout = bet * 2;

  if (payout <= 0) return { wallet: mapWallet(current), error: null };
  const wallet = await credit(
    userId,
    payout,
    room.isDraw ? 'refund' : 'win',
    room.isDraw ? 'Reembolso por empate' : 'Victoria en partida con apuesta',
    room.gameType
  );
  return { wallet, error: null };
}

// Refund a placed bet when leaving an unfinished room (idempotent).
export async function cancelBetAction(roomId: string): Promise<WalletResult> {
  const userId = await getUserId();
  if (!userId) return { wallet: null, error: 'No autenticado' };
  const room = await prisma.gameRoom.findUnique({ where: { id: roomId } });
  if (!room) return { wallet: null, error: 'Sala no encontrada' };
  if (room.status === 'finished') return { wallet: null, error: 'La partida ya terminó' };
  if (room.player1Id !== userId && room.player2Id !== userId) {
    return { wallet: null, error: 'No sos participante' };
  }
  const bet = Number((room.metadata as Record<string, unknown> | null)?.bet_amount ?? 0);
  const current = await prisma.wallet.findUnique({ where: { userId } });
  if (!current) return { wallet: null, error: 'Billetera no encontrada' };
  if (!(bet > 0)) return { wallet: mapWallet(current), error: null };

  try {
    await prisma.betSettlement.create({ data: { roomId, userId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { wallet: mapWallet(current), error: null };
    }
    throw err;
  }
  const wallet = await credit(userId, bet, 'refund', 'Reembolso por cancelar', room.gameType);
  return { wallet, error: null };
}

// Daily bonus, server-enforced to once per 24h.
export async function claimDailyBonusAction(): Promise<WalletResult> {
  const userId = await getUserId();
  if (!userId) return { wallet: null, error: 'No autenticado' };
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) return { wallet: null, error: 'Billetera no encontrada' };

  const lastBonus = await prisma.walletTransaction.findFirst({
    where: { walletId: wallet.id, type: 'bonus' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (lastBonus && lastBonus.createdAt > new Date(Date.now() - 24 * 60 * 60 * 1000)) {
    return { wallet: mapWallet(wallet), error: 'Ya reclamaste el bono diario' };
  }
  const updated = await credit(userId, 1000, 'bonus', 'Bonificacion diaria');
  return { wallet: updated, error: null };
}

// Single-player win credit (Plinko). NOTE: amount is client-asserted — see the
// wallet integrity note; provably-fair Plinko is a separate follow-up.
export async function creditWinAction(
  amount: number,
  gameSlug: string,
  description?: string
): Promise<WalletResult> {
  const userId = await getUserId();
  if (!userId) return { wallet: null, error: 'No autenticado' };
  if (!(amount > 0)) return { wallet: null, error: 'Monto inválido' };
  const wallet = await credit(userId, amount, 'win', description ?? 'Ganancia', gameSlug);
  return { wallet, error: null };
}
