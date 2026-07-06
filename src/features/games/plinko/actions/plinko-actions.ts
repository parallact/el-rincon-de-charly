'use server';

import { createHmac, createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@/generated/prisma';
import { prisma } from '@/lib/prisma';
import { getUserId } from '@/lib/auth-helpers';
import type { WalletDTO } from '@/features/wallet/actions/wallet-actions';
import type { RowCount, BallDirection } from '../types';
import { MULTIPLIERS, getMultiplier } from '../engine/multipliers';

const SUPPORTED_ROWS = new Set(Object.keys(MULTIPLIERS).map(Number));

function mapWallet(w: {
  id: string;
  userId: string;
  balance: Prisma.Decimal;
  createdAt: Date;
  updatedAt: Date;
}): WalletDTO {
  return {
    id: w.id,
    user_id: w.userId,
    balance: Number(w.balance),
    created_at: w.createdAt.toISOString(),
    updated_at: w.updatedAt.toISOString(),
  };
}

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

// A fresh commit-reveal seed pair. serverSeed stays secret (only its hash is
// published) until the seed is rotated and revealed.
function freshSeed(clientSeed?: string) {
  const serverSeed = randomBytes(32).toString('hex');
  const cs = clientSeed?.trim();
  return {
    serverSeed,
    serverSeedHash: sha256Hex(serverSeed),
    clientSeed: cs ? cs.slice(0, 64) : randomBytes(8).toString('hex'),
    nonce: 0,
  };
}

// Deterministic drop path: one direction per row from HMAC-SHA256(serverSeed,
// `${clientSeed}:${nonce}`). Anyone with the revealed serverSeed can reproduce
// it, which is what makes the game provably fair. rows <= 16 <= 32 digest bytes.
function derivePath(serverSeed: string, clientSeed: string, nonce: number, rows: number): BallDirection[] {
  const digest = createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest();
  const path: BallDirection[] = [];
  for (let i = 0; i < rows; i++) {
    path.push((digest[i] & 1) as BallDirection);
  }
  return path;
}

export interface PlinkoFairness {
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

// The public commitment for the caller's active seed (creating one on first use).
export async function getPlinkoFairnessAction(): Promise<PlinkoFairness | null> {
  const userId = await getUserId();
  if (!userId) return null;
  const seed = await prisma.plinkoSeed.upsert({
    where: { userId },
    update: {},
    create: { userId, ...freshSeed() },
    select: { serverSeedHash: true, clientSeed: true, nonce: true },
  });
  return seed;
}

export interface PlinkoDropResult {
  error: string | null;
  wallet: WalletDTO | null;
  path: BallDirection[];
  slot: number;
  multiplier: number;
  winAmount: number;
  nonce: number;
  serverSeedHash: string;
  clientSeed: string;
}

const EMPTY = {
  wallet: null,
  path: [] as BallDirection[],
  slot: 0,
  multiplier: 0,
  winAmount: 0,
  nonce: 0,
  serverSeedHash: '',
  clientSeed: '',
};

// Server-authoritative + provably-fair single Plinko drop. The server derives
// the outcome, debits the bet, credits the win, and records the round — all
// atomically. The client only animates the returned path; it never asserts the
// win amount.
export async function dropPlinkoBallAction(
  betAmount: number,
  rows: number
): Promise<PlinkoDropResult> {
  const userId = await getUserId();
  if (!userId) return { error: 'No autenticado', ...EMPTY };
  if (!Number.isFinite(betAmount) || betAmount <= 0) return { error: 'Monto inválido', ...EMPTY };
  if (!SUPPORTED_ROWS.has(rows)) return { error: 'Configuración inválida', ...EMPTY };

  // Ensure a seed exists (idempotent) before the transaction claims a nonce.
  await prisma.plinkoSeed.upsert({ where: { userId }, update: {}, create: { userId, ...freshSeed() } });

  const bet = new Prisma.Decimal(betAmount).toDecimalPlaces(2);

  try {
    const out = await prisma.$transaction(async (tx) => {
      // Atomically claim the next nonce (row lock on the seed row serializes
      // concurrent drops so each gets a distinct, unrepeatable outcome).
      const seed = await tx.plinkoSeed.update({ where: { userId }, data: { nonce: { increment: 1 } } });
      const nonce = seed.nonce - 1;
      const path = derivePath(seed.serverSeed, seed.clientSeed, nonce, rows);
      const slot = path.reduce<number>((a, b) => a + b, 0);
      const multiplier = getMultiplier(rows as RowCount, slot);
      const winAmount = bet.mul(multiplier).toDecimalPlaces(2);

      // Debit the bet (conditional decrement fails if the balance is too low).
      const dec = await tx.wallet.updateMany({
        where: { userId, balance: { gte: bet } },
        data: { balance: { decrement: bet }, updatedAt: new Date() },
      });
      if (dec.count === 0) throw new Error('Saldo insuficiente');
      let w = await tx.wallet.findUniqueOrThrow({ where: { userId } });
      await tx.walletTransaction.create({
        data: {
          walletId: w.id,
          type: 'bet',
          amount: bet.negated(),
          balanceAfter: w.balance,
          description: `Apuesta Plinko (${rows} filas)`,
          gameSlug: 'plinko',
        },
      });

      // Credit the win (skip when the multiplier lands on 0).
      if (winAmount.gt(0)) {
        w = await tx.wallet.update({
          where: { userId },
          data: { balance: { increment: winAmount }, updatedAt: new Date() },
        });
        await tx.walletTransaction.create({
          data: {
            walletId: w.id,
            type: 'win',
            amount: winAmount,
            balanceAfter: w.balance,
            description: `Plinko x${multiplier}`,
            gameSlug: 'plinko',
          },
        });
      }

      await tx.plinkoRound.create({
        data: {
          userId,
          betAmount: bet,
          rows,
          serverSeedHash: seed.serverSeedHash,
          clientSeed: seed.clientSeed,
          nonce,
          path: path.join(''),
          slot,
          multiplier: new Prisma.Decimal(multiplier),
          winAmount,
        },
      });

      return {
        wallet: w,
        path,
        slot,
        multiplier,
        winAmount: Number(winAmount),
        nonce,
        serverSeedHash: seed.serverSeedHash,
        clientSeed: seed.clientSeed,
      };
    });

    return {
      error: null,
      wallet: mapWallet(out.wallet),
      path: out.path,
      slot: out.slot,
      multiplier: out.multiplier,
      winAmount: out.winAmount,
      nonce: out.nonce,
      serverSeedHash: out.serverSeedHash,
      clientSeed: out.clientSeed,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Error al soltar la bola', ...EMPTY };
  }
}

export interface PlinkoRotateResult {
  revealed: { serverSeed: string; serverSeedHash: string; clientSeed: string; nonce: number } | null;
  next: { serverSeedHash: string; clientSeed: string };
}

// Rotate the seed: reveal the previous serverSeed (so the player can verify past
// rounds) and commit to a new one. Optionally set the next clientSeed.
export async function rotatePlinkoSeedAction(newClientSeed?: string): Promise<PlinkoRotateResult | null> {
  const userId = await getUserId();
  if (!userId) return null;
  const current = await prisma.plinkoSeed.findUnique({ where: { userId } });
  const next = freshSeed(newClientSeed);
  await prisma.plinkoSeed.upsert({
    where: { userId },
    update: {
      serverSeed: next.serverSeed,
      serverSeedHash: next.serverSeedHash,
      clientSeed: next.clientSeed,
      nonce: 0,
    },
    create: { userId, ...next },
  });
  return {
    revealed: current
      ? {
          serverSeed: current.serverSeed,
          serverSeedHash: current.serverSeedHash,
          clientSeed: current.clientSeed,
          nonce: current.nonce,
        }
      : null,
    next: { serverSeedHash: next.serverSeedHash, clientSeed: next.clientSeed },
  };
}
