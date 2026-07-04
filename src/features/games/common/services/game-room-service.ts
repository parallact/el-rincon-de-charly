'use client';

import type * as AblyTypes from 'ably';
import { getAblyClient } from '@/lib/realtime/ably-client';
import {
  getRoomAction,
  findAvailableRoomsAction,
  createRoomAction,
  joinRoomAction,
  makeMoveAction,
  endGameAction,
  leaveRoomAction,
  findOrCreateMatchAction,
  findOrCreateMatchV2Action,
  createPrivateRoomWithNegotiationAction,
  joinRoomWithBetPreferenceAction,
  submitBetProposalAction,
  acceptBetProposalAction,
  skipBettingAction,
  checkNegotiationTimeoutAction,
  requestRematchAction,
  acceptRematchAction,
  declineRematchAction,
  type GameRoomDTO,
} from '../actions/game-room-actions';

export type NegotiationState = 'none' | 'pending' | 'agreed' | 'no_bet';

export interface GameRoomMetadata {
  bet_amount?: number | null;
  negotiation_state?: NegotiationState;
  player1_bet_proposal?: number | null;
  player2_bet_proposal?: number | null;
  negotiation_deadline?: string | null;
}

export interface BetConfig {
  wantsToBet: boolean;
  betAmount: number;
}

// The room shape consumed across the app. Matches the server action DTO.
export type GameRoom = GameRoomDTO;
export type GameRoomWithPlayers = GameRoomDTO;

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

function mapConnectionState(state: AblyTypes.ConnectionState): ConnectionStatus {
  switch (state) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    default:
      return 'disconnected';
  }
}

class GameRoomService {
  // ---- Rooms
  async createRoom(_playerId: string, gameType = 'tic-tac-toe'): Promise<GameRoom | null> {
    return createRoomAction(gameType);
  }

  async createPrivateRoom(_playerId: string, gameType = 'tic-tac-toe'): Promise<GameRoom | null> {
    return createRoomAction(gameType, { isPrivate: true });
  }

  async findAvailableRooms(gameType = 'tic-tac-toe'): Promise<GameRoomWithPlayers[]> {
    return findAvailableRoomsAction(gameType);
  }

  async joinRoom(roomId: string, _playerId: string): Promise<GameRoom | null> {
    return joinRoomAction(roomId);
  }

  async getRoom(roomId: string): Promise<GameRoomWithPlayers | null> {
    return getRoomAction(roomId);
  }

  async makeMove(
    roomId: string,
    cellIndex: number,
    _playerId: string,
    newBoard: string[],
    expectedBoard?: string[]
  ): Promise<{ success: boolean; conflict: boolean; currentRoom?: GameRoom }> {
    const res = await makeMoveAction(roomId, cellIndex, newBoard, expectedBoard);
    return { success: res.success, conflict: res.conflict, currentRoom: res.currentRoom ?? undefined };
  }

  async endGame(roomId: string, winnerId: string | null, isDraw: boolean, finalBoard?: string[]): Promise<boolean> {
    return endGameAction(roomId, winnerId, isDraw, finalBoard);
  }

  async leaveRoom(roomId: string, _playerId: string): Promise<boolean> {
    return leaveRoomAction(roomId);
  }

  // ---- Matchmaking
  async findOrCreateMatch(_playerId: string, gameType = 'tic-tac-toe'): Promise<GameRoom | null> {
    return findOrCreateMatchAction(gameType);
  }

  async findOrCreateMatchWithBet(
    _playerId: string,
    betAmount: number,
    gameType = 'tic-tac-toe'
  ): Promise<GameRoom | null> {
    return findOrCreateMatchV2Action(gameType, true, betAmount);
  }

  async createPrivateRoomWithBet(
    _playerId: string,
    betAmount: number,
    gameType = 'tic-tac-toe'
  ): Promise<GameRoom | null> {
    return createPrivateRoomWithNegotiationAction(gameType, true, betAmount);
  }

  async findOrCreateMatchWithNegotiation(
    _playerId: string,
    gameType = 'tic-tac-toe',
    betConfig?: BetConfig
  ): Promise<GameRoom | null> {
    return findOrCreateMatchV2Action(gameType, betConfig?.wantsToBet ?? false, betConfig?.betAmount ?? null);
  }

  async createPrivateRoomWithNegotiation(
    _playerId: string,
    gameType = 'tic-tac-toe',
    betConfig?: BetConfig
  ): Promise<GameRoom | null> {
    return createPrivateRoomWithNegotiationAction(
      gameType,
      betConfig?.wantsToBet ?? false,
      betConfig?.betAmount ?? null
    );
  }

  async joinRoomWithBetPreference(
    roomId: string,
    _playerId: string,
    wantsBet = false,
    betAmount: number | null = null
  ): Promise<{ room: GameRoom | null; error: string | null }> {
    return joinRoomWithBetPreferenceAction(roomId, wantsBet, betAmount);
  }

  async joinRoomById(roomId: string, _playerId: string): Promise<{ room: GameRoom | null; error: string | null }> {
    return joinRoomWithBetPreferenceAction(roomId, false, null);
  }

  // ---- Bet negotiation
  async submitBetProposal(roomId: string, _playerId: string, amount: number): Promise<GameRoom | null> {
    return submitBetProposalAction(roomId, amount);
  }

  async acceptBetProposal(roomId: string, _playerId: string): Promise<GameRoom | null> {
    return acceptBetProposalAction(roomId);
  }

  async skipBetting(roomId: string, _playerId: string): Promise<GameRoom | null> {
    return skipBettingAction(roomId);
  }

  async checkNegotiationTimeout(roomId: string): Promise<GameRoom | null> {
    return checkNegotiationTimeoutAction(roomId);
  }

  getNegotiationState(room: GameRoom): {
    state: NegotiationState;
    myProposal: number | null;
    theirProposal: number | null;
    deadline: Date | null;
    agreedAmount: number | null;
  } | null {
    const metadata = room.metadata as GameRoomMetadata | null;
    if (!metadata) return null;
    return {
      state: metadata.negotiation_state ?? 'none',
      myProposal: null,
      theirProposal: null,
      deadline: metadata.negotiation_deadline ? new Date(metadata.negotiation_deadline) : null,
      agreedAmount: metadata.bet_amount ?? null,
    };
  }

  // ---- Rematch
  async requestRematch(roomId: string, _playerId: string): Promise<boolean> {
    return requestRematchAction(roomId);
  }

  async acceptRematch(roomId: string, _playerId: string): Promise<GameRoom | null> {
    return acceptRematchAction(roomId);
  }

  async declineRematch(roomId: string): Promise<boolean> {
    return declineRematchAction(roomId);
  }

  // ---- Realtime (Ably websockets)
  subscribeToRoom(
    roomId: string,
    callback: (room: GameRoom) => void,
    onError?: (error: Error) => void,
    onStatusChange?: (status: ConnectionStatus) => void
  ): () => void {
    const client = getAblyClient();
    if (!client) {
      // No realtime available (SSR or misconfigured) — the caller's polling
      // fallback takes over.
      onStatusChange?.('disconnected');
      return () => {};
    }

    const channel = client.channels.get(`room:${roomId}`);

    const messageListener = (msg: AblyTypes.InboundMessage) => {
      if (msg.data) callback(msg.data as GameRoom);
    };

    const connectionListener = (stateChange: AblyTypes.ConnectionStateChange) => {
      onStatusChange?.(mapConnectionState(stateChange.current));
      if (stateChange.current === 'failed' && onError) {
        onError(new Error('No se pudo conectar al servidor en tiempo real'));
      }
    };

    onStatusChange?.(mapConnectionState(client.connection.state));
    client.connection.on(connectionListener);
    channel.subscribe('update', messageListener);

    return () => {
      channel.unsubscribe('update', messageListener);
      client.connection.off(connectionListener);
    };
  }
}

export const gameRoomService = new GameRoomService();
export default gameRoomService;
