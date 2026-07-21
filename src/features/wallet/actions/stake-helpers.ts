import 'server-only';
import { Prisma } from '@/generated/prisma';

// Server-authoritative PvP stake handling.
//
// A PvP bet is only "real" once BOTH players' stakes have been debited server-side
// and recorded in the BetStake ledger, inside the SAME transaction that flips the
// room to agreed/playing. The client can no longer mint money by reaching the
// agreed state while skipping its own debit — the payout in settleBetAction is
// computed from the SUM of confirmed BetStake rows, not from client metadata.

/**
 * Atomically debit BOTH players' agreed stake and record the ledger rows, within
 * an existing transaction.
 *
 * Returns `true` iff both stakes were debited. If either player lacks a wallet or
 * cannot cover the amount, NO wallet is touched and it returns `false` — the
 * caller must then refuse to enter the 'agreed' state (fall back to 'no_bet').
 *
 * Both wallet rows are locked `FOR UPDATE` up front so the balance check and the
 * two decrements are serialized against any concurrent debit of the same wallets.
 */
export async function debitAgreedStakes(
  tx: Prisma.TransactionClient,
  roomId: string,
  player1Id: string | null,
  player2Id: string | null,
  amount: number,
  gameSlug: string
): Promise<boolean> {
  if (!player1Id || !player2Id) return false;
  if (player1Id === player2Id) return false;
  if (!Number.isFinite(amount) || !(amount > 0)) return false;

  const dec = new Prisma.Decimal(amount);
  const players = [player1Id, player2Id];

  // Lock both wallet rows for the duration of the transaction.
  await tx.$queryRaw`SELECT "userId" FROM "Wallet" WHERE "userId" = ${player1Id} OR "userId" = ${player2Id} FOR UPDATE`;

  // Check both balances BEFORE any decrement so we never leave one player debited
  // while the other could not pay.
  const wallets = await tx.wallet.findMany({ where: { userId: { in: players } } });
  if (wallets.length !== 2) return false; // a wallet is missing
  if (wallets.some((w) => w.balance.lessThan(dec))) return false;

  // A stake row already existing for this room means the room was already staked
  // (e.g. a retried transition) — do not debit twice.
  const existing = await tx.betStake.count({ where: { roomId } });
  if (existing > 0) return false;

  for (const userId of players) {
    const w = await tx.wallet.update({
      where: { userId },
      data: { balance: { decrement: dec }, updatedAt: new Date() },
    });
    await tx.walletTransaction.create({
      data: {
        walletId: w.id,
        type: 'bet',
        amount: new Prisma.Decimal(-amount),
        balanceAfter: w.balance,
        description: 'Apuesta acordada',
        gameSlug,
      },
    });
    await tx.betStake.create({ data: { roomId, userId, amount: dec } });
  }
  return true;
}
