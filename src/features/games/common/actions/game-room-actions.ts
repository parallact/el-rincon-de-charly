'use server';

import { Prisma } from '@/generated/prisma';
import { prisma } from '@/lib/prisma';
import { auth } from '@/auth';
import { publishRoom } from '@/lib/realtime/ably-server';

// Serializable room shape returned to the client — mirrors the legacy Supabase
// GameRoom (snake_case) so the client service and consumers stay unchanged.
export interface GameRoomDTO {
  id: string;
  game_type: string;
  status: 'waiting' | 'playing' | 'finished';
  player1_id: string | null;
  player2_id: string | null;
  current_turn: string | null;
  board: string[];
  winner_id: string | null;
  is_draw: boolean;
  is_private: boolean;
  rematch_requested_by: string | null;
  rematch_room_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  player1?: { id: string; username: string | null; avatar_url: string | null };
  player2?: { id: string; username: string | null; avatar_url: string | null };
}

type RoomRow = Prisma.GameRoomGetPayload<{
  include: {
    player1: { select: { id: true; username: true; avatarUrl: true } };
    player2: { select: { id: true; username: true; avatarUrl: true } };
  };
}>;

const ROOM_INCLUDE = {
  player1: { select: { id: true, username: true, avatarUrl: true } },
  player2: { select: { id: true, username: true, avatarUrl: true } },
} as const;

const EMPTY_BOARD = ['', '', '', '', '', '', '', '', ''];

function mapRoom(row: RoomRow): GameRoomDTO {
  return {
    id: row.id,
    game_type: row.gameType,
    status: row.status as GameRoomDTO['status'],
    player1_id: row.player1Id,
    player2_id: row.player2Id,
    current_turn: row.currentTurn,
    board: (row.board as string[]) ?? EMPTY_BOARD,
    winner_id: row.winnerId,
    is_draw: row.isDraw,
    is_private: row.isPrivate,
    rematch_requested_by: row.rematchRequestedBy,
    rematch_room_id: row.rematchRoomId,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    player1: row.player1
      ? { id: row.player1.id, username: row.player1.username, avatar_url: row.player1.avatarUrl }
      : undefined,
    player2: row.player2
      ? { id: row.player2.id, username: row.player2.username, avatar_url: row.player2.avatarUrl }
      : undefined,
  };
}

async function requireUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

// ---------------------------------------------------------------- reads

export async function getRoomAction(roomId: string): Promise<GameRoomDTO | null> {
  if (!roomId) return null;
  const row = await prisma.gameRoom.findUnique({ where: { id: roomId }, include: ROOM_INCLUDE });
  return row ? mapRoom(row) : null;
}

// Fetch the room and broadcast it to subscribers (used after a mutation).
async function fetchAndPublish(roomId: string): Promise<GameRoomDTO | null> {
  const room = await getRoomAction(roomId);
  await publishRoom(room);
  return room;
}

export async function findAvailableRoomsAction(gameType = 'tic-tac-toe'): Promise<GameRoomDTO[]> {
  const rows = await prisma.gameRoom.findMany({
    where: { status: 'waiting', gameType, player2Id: null, isPrivate: false },
    include: ROOM_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  return rows.map(mapRoom);
}

// ---------------------------------------------------------------- create

export async function createRoomAction(
  gameType = 'tic-tac-toe',
  opts: { isPrivate?: boolean; metadata?: Record<string, unknown> } = {}
): Promise<GameRoomDTO | null> {
  const userId = await requireUserId();
  if (!userId) return null;
  const row = await prisma.gameRoom.create({
    data: {
      gameType,
      player1Id: userId,
      currentTurn: userId,
      status: 'waiting',
      isPrivate: opts.isPrivate ?? false,
      ...(opts.metadata ? { metadata: opts.metadata as Prisma.InputJsonValue } : {}),
    },
    include: ROOM_INCLUDE,
  });
  return mapRoom(row);
}

// ---------------------------------------------------------------- join

export async function joinRoomAction(roomId: string): Promise<GameRoomDTO | null> {
  const userId = await requireUserId();
  if (!userId || !roomId) return null;

  // Atomic conditional join: only if still waiting, empty, and not our own room.
  const result = await prisma.gameRoom.updateMany({
    where: { id: roomId, status: 'waiting', player2Id: null, player1Id: { not: userId } },
    data: { player2Id: userId, status: 'playing', updatedAt: new Date() },
  });
  if (result.count === 0) return null; // already taken / own room
  return fetchAndPublish(roomId);
}

// ---------------------------------------------------------------- moves

export async function makeMoveAction(
  roomId: string,
  cellIndex: number,
  newBoard: string[],
  expectedBoard?: string[]
): Promise<{ success: boolean; conflict: boolean; currentRoom?: GameRoomDTO }> {
  const userId = await requireUserId();
  if (!userId) return { success: false, conflict: false };
  if (cellIndex < 0 || cellIndex > 8) return { success: false, conflict: false };

  const outcome = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{ id: string; board: unknown; current_turn: string | null; player1_id: string | null; player2_id: string | null; status: string }>
    >`SELECT "id","board","currentTurn" as current_turn,"player1Id" as player1_id,"player2Id" as player2_id,"status"
        FROM "GameRoom" WHERE "id" = ${roomId} FOR UPDATE`;
    const room = rows[0];
    if (!room) return { success: false, conflict: false };
    if (room.status !== 'playing') return { success: false, conflict: true };
    if (room.current_turn !== userId) {
      const fresh = await getRoomAction(roomId);
      return { success: false, conflict: true, currentRoom: fresh ?? undefined };
    }
    const serverBoard = (room.board as string[]) ?? EMPTY_BOARD;
    if (serverBoard[cellIndex] && serverBoard[cellIndex] !== '') {
      const fresh = await getRoomAction(roomId);
      return { success: false, conflict: true, currentRoom: fresh ?? undefined };
    }
    if (expectedBoard && !serverBoard.every((c, i) => c === expectedBoard[i])) {
      const fresh = await getRoomAction(roomId);
      return { success: false, conflict: true, currentRoom: fresh ?? undefined };
    }
    const nextTurn = room.player1_id === userId ? room.player2_id : room.player1_id;
    await tx.gameRoom.update({
      where: { id: roomId },
      data: { board: newBoard, currentTurn: nextTurn, updatedAt: new Date() },
    });
    return { success: true, conflict: false };
  });

  if (outcome.success) {
    await publishRoom(await getRoomAction(roomId));
  }
  return outcome;
}

// ---------------------------------------------------------------- end / leave

export async function endGameAction(
  roomId: string,
  winnerId: string | null,
  isDraw: boolean,
  finalBoard?: string[]
): Promise<boolean> {
  const userId = await requireUserId();
  if (!userId) return false;
  // Only a participant may end the game.
  const room = await prisma.gameRoom.findFirst({
    where: { id: roomId, OR: [{ player1Id: userId }, { player2Id: userId }] },
    select: { id: true },
  });
  if (!room) return false;
  await prisma.gameRoom.update({
    where: { id: roomId },
    data: {
      status: 'finished',
      winnerId,
      isDraw,
      updatedAt: new Date(),
      ...(finalBoard ? { board: finalBoard } : {}),
    },
  });
  await publishRoom(await getRoomAction(roomId));
  return true;
}

export async function leaveRoomAction(roomId: string): Promise<boolean> {
  const userId = await requireUserId();
  if (!userId) return false;
  const room = await prisma.gameRoom.findUnique({ where: { id: roomId } });
  if (!room) return false;

  if (room.status === 'waiting' && room.player1Id === userId) {
    await prisma.gameRoom.delete({ where: { id: roomId } });
    return true;
  }
  if (room.status === 'playing' && (room.player1Id === userId || room.player2Id === userId)) {
    const winnerId = room.player1Id === userId ? room.player2Id : room.player1Id;
    await prisma.gameRoom.update({
      where: { id: roomId },
      data: { status: 'finished', winnerId, isDraw: false, updatedAt: new Date() },
    });
    await publishRoom(await getRoomAction(roomId));
    return true;
  }
  return true;
}

// ---------------------------------------------------------------- matchmaking

// Find a joinable public waiting room (locked, skip-locked) or create a new one.
// Replaces the find_or_create_match SECURITY DEFINER function.
async function matchmake(
  userId: string,
  gameType: string,
  createMetadata: Prisma.InputJsonValue | undefined,
  onJoin: (roomMeta: Record<string, unknown> | null) => { metadata: Prisma.InputJsonValue; status: 'playing' | 'waiting' } | null
): Promise<GameRoomDTO | null> {
  const joinedId = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; metadata: unknown }>>`
      SELECT "id","metadata" FROM "GameRoom"
      WHERE "gameType" = ${gameType} AND "status" = 'waiting' AND "isPrivate" = false
        AND "player2Id" IS NULL AND ("player1Id" IS NULL OR "player1Id" <> ${userId})
      ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED`;
    const candidate = rows[0];
    if (!candidate) return null;
    const decision = onJoin((candidate.metadata as Record<string, unknown> | null) ?? null);
    if (!decision) return null;
    await tx.gameRoom.update({
      where: { id: candidate.id },
      data: { player2Id: userId, status: decision.status, metadata: decision.metadata, updatedAt: new Date() },
    });
    return candidate.id;
  });

  if (joinedId) return fetchAndPublish(joinedId);

  // No room to join — create a fresh public one.
  const row = await prisma.gameRoom.create({
    data: {
      gameType,
      player1Id: userId,
      currentTurn: userId,
      status: 'waiting',
      isPrivate: false,
      ...(createMetadata ? { metadata: createMetadata } : {}),
    },
    include: ROOM_INCLUDE,
  });
  return mapRoom(row);
}

export async function findOrCreateMatchAction(gameType = 'tic-tac-toe'): Promise<GameRoomDTO | null> {
  const userId = await requireUserId();
  if (!userId) return null;
  return matchmake(userId, gameType, undefined, () => ({ metadata: {} as Prisma.InputJsonValue, status: 'playing' }));
}

// Bet-negotiation matchmaking (replaces find_or_create_match_v2).
export async function findOrCreateMatchV2Action(
  gameType = 'tic-tac-toe',
  wantsBet = false,
  betAmount: number | null = null
): Promise<GameRoomDTO | null> {
  const userId = await requireUserId();
  if (!userId) return null;

  const createMeta = {
    negotiation_state: 'none',
    player1_bet_proposal: wantsBet ? betAmount : null,
  } as unknown as Prisma.InputJsonValue;

  return matchmake(userId, gameType, createMeta, (roomMeta) => {
    const p1Proposal = Number(roomMeta?.player1_bet_proposal ?? 0);
    const p1WantsBet = p1Proposal > 0;
    let negotiationState: string;
    let finalBet: number | null = null;
    let status: 'playing' | 'waiting' = 'playing';

    if (!p1WantsBet && !wantsBet) {
      negotiationState = 'none';
    } else if (p1WantsBet && wantsBet && p1Proposal === betAmount) {
      negotiationState = 'agreed';
      finalBet = betAmount;
    } else if (p1WantsBet && wantsBet) {
      negotiationState = 'pending';
      status = 'waiting';
    } else {
      negotiationState = 'no_bet';
    }
    const deadline = negotiationState === 'pending' ? new Date(Date.now() + 30000).toISOString() : null;
    const metadata = {
      negotiation_state: negotiationState,
      bet_amount: finalBet,
      player1_bet_proposal: p1Proposal || null,
      player2_bet_proposal: wantsBet && betAmount ? betAmount : null,
      negotiation_deadline: deadline,
    } as unknown as Prisma.InputJsonValue;
    return { metadata, status };
  });
}

export async function createPrivateRoomWithNegotiationAction(
  gameType = 'tic-tac-toe',
  wantsBet = false,
  betAmount: number | null = null
): Promise<GameRoomDTO | null> {
  const userId = await requireUserId();
  if (!userId) return null;
  const metadata = {
    negotiation_state: 'none',
    player1_bet_proposal: wantsBet ? betAmount : null,
  } as unknown as Prisma.InputJsonValue;
  const row = await prisma.gameRoom.create({
    data: { gameType, player1Id: userId, currentTurn: userId, status: 'waiting', isPrivate: true, metadata },
    include: ROOM_INCLUDE,
  });
  return mapRoom(row);
}

// Join a specific room by id (invite links), carrying a bet preference.
export async function joinRoomWithBetPreferenceAction(
  roomId: string,
  wantsBet = false,
  betAmount: number | null = null
): Promise<{ room: GameRoomDTO | null; error: string | null }> {
  const userId = await requireUserId();
  if (!userId) return { room: null, error: 'Usuario no autenticado' };
  if (!roomId) return { room: null, error: 'ID de sala no válido' };

  const joined = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; metadata: unknown; player1_id: string | null; status: string; player2_id: string | null }>>`
      SELECT "id","metadata","player1Id" as player1_id,"status","player2Id" as player2_id
        FROM "GameRoom" WHERE "id" = ${roomId} FOR UPDATE`;
    const room = rows[0];
    if (!room) return { error: 'Sala no encontrada' as string };
    if (room.player1_id === userId) return { ok: true };
    if (room.status !== 'waiting') return { error: 'Esta sala ya no está disponible' };
    if (room.player2_id !== null) return { error: 'Esta sala ya está llena' };

    const meta = (room.metadata as Record<string, unknown> | null) ?? null;
    const p1Proposal = Number(meta?.player1_bet_proposal ?? 0);
    const p1WantsBet = p1Proposal > 0;
    let negotiationState: string;
    let finalBet: number | null = null;
    let status: 'playing' | 'waiting' = 'playing';
    if (!p1WantsBet && !wantsBet) negotiationState = 'none';
    else if (p1WantsBet && wantsBet && p1Proposal === betAmount) { negotiationState = 'agreed'; finalBet = betAmount; }
    else if (p1WantsBet && wantsBet) { negotiationState = 'pending'; status = 'waiting'; }
    else negotiationState = 'no_bet';
    const deadline = negotiationState === 'pending' ? new Date(Date.now() + 30000).toISOString() : null;
    const metadata = {
      negotiation_state: negotiationState,
      bet_amount: finalBet,
      player1_bet_proposal: p1Proposal || null,
      player2_bet_proposal: wantsBet && betAmount ? betAmount : null,
      negotiation_deadline: deadline,
    } as unknown as Prisma.InputJsonValue;
    await tx.gameRoom.update({ where: { id: roomId }, data: { player2Id: userId, status, metadata, updatedAt: new Date() } });
    return { ok: true };
  });

  if ('error' in joined && joined.error) return { room: null, error: joined.error };
  return { room: await fetchAndPublish(roomId), error: null };
}

// ---------------------------------------------------------------- bet negotiation

async function loadParticipantRoom(tx: Prisma.TransactionClient, roomId: string, userId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; metadata: unknown; player1_id: string | null; player2_id: string | null }>>`
    SELECT "id","metadata","player1Id" as player1_id,"player2Id" as player2_id
      FROM "GameRoom" WHERE "id" = ${roomId} FOR UPDATE`;
  const room = rows[0];
  if (!room) throw new Error('Room not found');
  const isPlayer1 = room.player1_id === userId;
  if (!isPlayer1 && room.player2_id !== userId) throw new Error('Player not in room');
  return { room, isPlayer1, meta: (room.metadata as Record<string, unknown> | null) ?? {} };
}

export async function submitBetProposalAction(roomId: string, amount: number): Promise<GameRoomDTO | null> {
  const userId = await requireUserId();
  if (!userId || !roomId) return null;
  await prisma.$transaction(async (tx) => {
    const { room, isPlayer1, meta } = await loadParticipantRoom(tx, roomId, userId);
    if (meta.negotiation_state !== 'pending') throw new Error('Not in negotiation state');
    const otherProposal = Number(isPlayer1 ? meta.player2_bet_proposal : meta.player1_bet_proposal) || null;
    const myKey = isPlayer1 ? 'player1_bet_proposal' : 'player2_bet_proposal';
    let newMeta: Record<string, unknown>;
    let status: 'playing' | 'waiting' = 'waiting';
    if (amount === otherProposal) {
      newMeta = { ...meta, negotiation_state: 'agreed', bet_amount: amount, [myKey]: amount };
      status = 'playing';
    } else {
      newMeta = { ...meta, [myKey]: amount, negotiation_deadline: new Date(Date.now() + 30000).toISOString() };
    }
    await tx.gameRoom.update({ where: { id: room.id }, data: { metadata: newMeta as Prisma.InputJsonValue, status, updatedAt: new Date() } });
  });
  return fetchAndPublish(roomId);
}

export async function acceptBetProposalAction(roomId: string): Promise<GameRoomDTO | null> {
  const userId = await requireUserId();
  if (!userId || !roomId) return null;
  await prisma.$transaction(async (tx) => {
    const { room, isPlayer1, meta } = await loadParticipantRoom(tx, roomId, userId);
    if (meta.negotiation_state !== 'pending') throw new Error('Not in negotiation state');
    const otherProposal = Number(isPlayer1 ? meta.player2_bet_proposal : meta.player1_bet_proposal) || null;
    if (!otherProposal || otherProposal <= 0) throw new Error('No valid proposal to accept');
    const myKey = isPlayer1 ? 'player1_bet_proposal' : 'player2_bet_proposal';
    const newMeta = { ...meta, negotiation_state: 'agreed', bet_amount: otherProposal, [myKey]: otherProposal };
    await tx.gameRoom.update({ where: { id: room.id }, data: { metadata: newMeta as Prisma.InputJsonValue, status: 'playing', updatedAt: new Date() } });
  });
  return fetchAndPublish(roomId);
}

export async function skipBettingAction(roomId: string): Promise<GameRoomDTO | null> {
  const userId = await requireUserId();
  if (!userId || !roomId) return null;
  await prisma.$transaction(async (tx) => {
    const { room, meta } = await loadParticipantRoom(tx, roomId, userId);
    const newMeta = { ...meta, negotiation_state: 'no_bet', bet_amount: null };
    await tx.gameRoom.update({ where: { id: room.id }, data: { metadata: newMeta as Prisma.InputJsonValue, status: 'playing', updatedAt: new Date() } });
  });
  return fetchAndPublish(roomId);
}

export async function checkNegotiationTimeoutAction(roomId: string): Promise<GameRoomDTO | null> {
  if (!roomId) return null;
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; metadata: unknown }>>`
      SELECT "id","metadata" FROM "GameRoom" WHERE "id" = ${roomId} FOR UPDATE`;
    const room = rows[0];
    if (!room) return;
    const meta = (room.metadata as Record<string, unknown> | null) ?? {};
    if (meta.negotiation_state !== 'pending') return;
    const deadline = meta.negotiation_deadline ? new Date(String(meta.negotiation_deadline)) : null;
    if (deadline && Date.now() > deadline.getTime()) {
      const newMeta = { ...meta, negotiation_state: 'no_bet', bet_amount: null };
      await tx.gameRoom.update({ where: { id: room.id }, data: { metadata: newMeta as Prisma.InputJsonValue, status: 'playing', updatedAt: new Date() } });
    }
  });
  return fetchAndPublish(roomId);
}

// ---------------------------------------------------------------- rematch

export async function requestRematchAction(roomId: string): Promise<boolean> {
  const userId = await requireUserId();
  if (!userId || !roomId) return false;
  const room = await prisma.gameRoom.findFirst({
    where: { id: roomId, status: 'finished', OR: [{ player1Id: userId }, { player2Id: userId }] },
    select: { id: true },
  });
  if (!room) return false;
  await prisma.gameRoom.update({ where: { id: roomId }, data: { rematchRequestedBy: userId, updatedAt: new Date() } });
  await publishRoom(await getRoomAction(roomId));
  return true;
}

export async function acceptRematchAction(roomId: string): Promise<GameRoomDTO | null> {
  const userId = await requireUserId();
  if (!userId || !roomId) return null;
  const room = await prisma.gameRoom.findUnique({ where: { id: roomId } });
  if (!room || room.status !== 'finished' || !room.rematchRequestedBy) return null;
  if (room.rematchRequestedBy === userId) return null; // can't accept your own
  if (room.player1Id !== userId && room.player2Id !== userId) return null;

  // Swap roles: the accepter's old opponent starts.
  const newRoom = await prisma.gameRoom.create({
    data: {
      gameType: room.gameType,
      player1Id: room.player2Id,
      player2Id: room.player1Id,
      currentTurn: room.player2Id,
      status: 'playing',
    },
    include: ROOM_INCLUDE,
  });
  await prisma.gameRoom.update({
    where: { id: roomId },
    data: { rematchRoomId: newRoom.id, rematchRequestedBy: null, updatedAt: new Date() },
  });
  // Notify the requester (subscribed to the old room) that the rematch room exists.
  await publishRoom(await getRoomAction(roomId));
  return mapRoom(newRoom);
}

export async function declineRematchAction(roomId: string): Promise<boolean> {
  const userId = await requireUserId();
  if (!userId || !roomId) return false;
  await prisma.gameRoom.updateMany({
    where: { id: roomId, OR: [{ player1Id: userId }, { player2Id: userId }] },
    data: { rematchRequestedBy: null, updatedAt: new Date() },
  });
  await publishRoom(await getRoomAction(roomId));
  return true;
}
