'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { gameRoomService, type GameRoom, type GameRoomWithPlayers, type ConnectionStatus, type NegotiationState, type BetConfig, type GameRoomMetadata } from '../services/game-room-service';
import { useWalletStore } from '@/features/wallet/store/wallet-store';
import { createLogger } from '@/lib/utils/logger';

const log = createLogger({ prefix: 'OnlineGameCore' });

// Timeout constants for search states
const SEARCH_TIMEOUT_MS = 60000;      // 60s for searching
const WAITING_TIMEOUT_MS = 120000;    // 2min for waiting (private rooms)
const NEGOTIATION_TIMEOUT_MS = 35000; // 35s for negotiating
const MAX_POLL_FAILURES = 5;          // Circuit breaker for polling

export type OnlineGameStatus = 'idle' | 'searching' | 'waiting' | 'negotiating' | 'playing' | 'finished';

export type { NegotiationState, BetConfig };
export type RematchStatus = 'none' | 'requested' | 'received' | 'accepted';

export interface OnlineGameCoreOptions {
  userId: string;
  gameType?: string;
  onRoomUpdate?: (room: GameRoom) => void;
  onGameFinished?: (room: GameRoom) => void;
  onStatusChange?: (status: OnlineGameStatus) => void;
}

export interface NegotiationInfo {
  state: NegotiationState;
  myProposal: number | null;
  opponentProposal: number | null;
  deadline: string | null;
}

export interface OnlineGameCoreReturn {
  // State
  status: OnlineGameStatus;
  room: GameRoomWithPlayers | null;
  error: string | null;
  connectionStatus: ConnectionStatus;
  rematchStatus: RematchStatus;
  betAmount: number | null;
  potTotal: number;
  isPrivateRoom: boolean;
  negotiation: NegotiationInfo;

  // Actions - Matchmaking
  findMatch: () => Promise<void>;
  createPrivateRoom: () => Promise<void>;
  joinRoom: (roomId: string) => Promise<void>;
  findMatchWithBet: (amount: number) => Promise<boolean>;
  createPrivateRoomWithBet: (amount: number) => Promise<boolean>;

  // Actions - Game
  leaveGame: () => Promise<void>;
  updateRoom: (updates: Partial<GameRoom>) => Promise<boolean>;

  // Actions - Rematch
  requestRematch: () => Promise<void>;
  acceptRematch: () => Promise<void>;
  declineRematch: () => Promise<void>;

  // Actions - Negotiation
  submitBetProposal: (amount: number) => Promise<void>;
  acceptBetProposal: () => Promise<void>;
  skipBetting: () => Promise<void>;

  // Internal - for game-specific hooks to use
  setStatus: (status: OnlineGameStatus) => void;
  setRoom: React.Dispatch<React.SetStateAction<GameRoomWithPlayers | null>>;
  setError: (error: string | null) => void;
  cleanupSubscription: () => void;
  subscribeToRoom: (roomId: string) => void;

  // Refs for callbacks
  statusRef: React.MutableRefObject<OnlineGameStatus>;
  userIdRef: React.MutableRefObject<string>;
}

export function useOnlineGameCore({
  userId,
  gameType = 'tic-tac-toe',
  onRoomUpdate,
  onGameFinished,
  onStatusChange,
}: OnlineGameCoreOptions): OnlineGameCoreReturn {
  const [status, setStatusInternal] = useState<OnlineGameStatus>('idle');
  const [room, setRoom] = useState<GameRoomWithPlayers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rematchStatus, setRematchStatus] = useState<RematchStatus>('none');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [betAmount, setBetAmount] = useState<number | null>(null);
  const [negotiation, setNegotiation] = useState<NegotiationInfo>({
    state: 'none',
    myProposal: null,
    opponentProposal: null,
    deadline: null,
  });

  const unsubscribeRef = useRef<(() => void) | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const rematchStatusRef = useRef(rematchStatus);
  rematchStatusRef.current = rematchStatus;
  const betAmountRef = useRef(betAmount);
  betAmountRef.current = betAmount;
  const betDeductedForRoomRef = useRef<string | null>(null); // Track which room we've deducted bet for
  const betSettledForRoomRef = useRef<string | null>(null); // Track which room we've paid out/refunded for (prevents double credit)
  const pollFailureCountRef = useRef(0); // Circuit breaker for polling
  const isCleaningUpRef = useRef(false); // Guard against multiple cleanup calls
  const onRoomUpdateRef = useRef(onRoomUpdate);
  onRoomUpdateRef.current = onRoomUpdate;
  const onGameFinishedRef = useRef(onGameFinished);
  onGameFinishedRef.current = onGameFinished;

  // Refs for circular dependencies between callbacks
  const handleRematchAcceptedRef = useRef<((newRoomId: string) => Promise<void>) | undefined>(undefined);
  const subscribeToRoomRef = useRef<((roomId: string) => void) | undefined>(undefined);

  // Wrapper to track status changes
  const setStatus = useCallback((newStatus: OnlineGameStatus) => {
    setStatusInternal(newStatus);
    onStatusChange?.(newStatus);
  }, [onStatusChange]);

  // Cleanup helper with guard against multiple calls
  const cleanupSubscription = useCallback(() => {
    if (isCleaningUpRef.current) {
      log.log('Cleanup already in progress, skipping');
      return;
    }

    isCleaningUpRef.current = true;
    try {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    } catch (err) {
      log.error('Error during cleanup:', err);
    } finally {
      setConnectionStatus('disconnected');
      isCleaningUpRef.current = false;
    }
  }, []);

  // Connection status handler
  const handleConnectionStatus = useCallback((newStatus: ConnectionStatus) => {
    log.log('Connection status:', newStatus);
    setConnectionStatus(newStatus);
  }, []);

  // Subscription error handler
  const handleSubscriptionError = useCallback((err: Error) => {
    log.error('Subscription error:', err);
    setError('Error de conexion. Reconectando...');
  }, []);

  // Room update handler
  const handleRoomUpdate = useCallback((updatedRoom: GameRoom) => {
    log.log('Room update:', updatedRoom.status, 'current status:', statusRef.current);

    // Validate timestamp to prevent stale updates
    setRoom(prev => {
      if (prev && updatedRoom.updated_at) {
        const prevTime = new Date(prev.updated_at).getTime();
        const newTime = new Date(updatedRoom.updated_at).getTime();
        if (newTime < prevTime) {
          log.log('Ignoring stale update:', newTime, '<', prevTime);
          return prev;
        }
      }
      return prev ? { ...prev, ...updatedRoom } : null;
    });

    // Extract negotiation info from metadata
    const metadata = updatedRoom.metadata as GameRoomMetadata | null;
    if (metadata) {
      const isPlayer1 = updatedRoom.player1_id === userIdRef.current;
      const negotiationState = metadata.negotiation_state || 'none';

      setNegotiation({
        state: negotiationState,
        myProposal: isPlayer1 ? metadata.player1_bet_proposal ?? null : metadata.player2_bet_proposal ?? null,
        opponentProposal: isPlayer1 ? metadata.player2_bet_proposal ?? null : metadata.player1_bet_proposal ?? null,
        deadline: metadata.negotiation_deadline ?? null,
      });

      // Stake handling when agreement is reached. The stake is debited
      // server-side (both players, atomically) at the moment the room enters
      // 'agreed', so the client no longer debits here — it just reflects the
      // agreed amount and refreshes the (now server-debited) balance once.
      if (negotiationState === 'agreed' && metadata.bet_amount && metadata.bet_amount > 0) {
        setBetAmount(metadata.bet_amount);
        if (betDeductedForRoomRef.current !== updatedRoom.id) {
          betDeductedForRoomRef.current = updatedRoom.id;
          useWalletStore.getState().refreshWallet();
        }
      }

      // Handle negotiation status
      if (negotiationState === 'pending' && statusRef.current !== 'negotiating') {
        log.log('Entering negotiation state');
        setStatus('negotiating');
      } else if ((negotiationState === 'agreed' || negotiationState === 'no_bet') && statusRef.current === 'negotiating') {
        log.log('Negotiation resolved:', negotiationState);
        setStatus('playing');
      }
    }

    // Notify game-specific handler
    onRoomUpdateRef.current?.(updatedRoom);

    // Handle status transitions (only if not in negotiation)
    const negotiationState = (updatedRoom.metadata as GameRoomMetadata | null)?.negotiation_state;
    if (updatedRoom.status === 'playing' && statusRef.current === 'waiting' && negotiationState !== 'pending') {
      setStatus('playing');
    }

    if (updatedRoom.status === 'finished') {
      // Process bet results — but only once per room. handleRoomUpdate runs on
      // every room update (realtime + polling fallback), and a finished room is
      // re-emitted whenever rematch fields change, so without this guard the
      // winner would be credited multiple times for the same game.
      const roomBetAmount = (updatedRoom.metadata as { bet_amount?: number } | null)?.bet_amount;
      if (roomBetAmount && roomBetAmount > 0 && betSettledForRoomRef.current !== updatedRoom.id) {
        // Mark as settled synchronously before awaiting to prevent re-entrancy.
        betSettledForRoomRef.current = updatedRoom.id;
        const walletStore = useWalletStore.getState();
        const roomId = updatedRoom.id;

        // Settlement is server-authoritative: the RPC reads the finished room's
        // winner/draw and pays the caller at most once. We no longer compute the
        // payout (or trust a client amount) here.
        (async () => {
          try {
            await walletStore.settleBet(roomId);
          } catch (err) {
            log.error('Error settling bet:', err);
            // Allow a retry on the next finished update if settlement failed.
            betSettledForRoomRef.current = null;
          }
        })();
      }

      // Handle rematch detection
      const wasRequested = rematchStatusRef.current === 'requested';
      if (updatedRoom.rematch_room_id && wasRequested) {
        log.log('Rematch accepted! Joining new room:', updatedRoom.rematch_room_id);
        handleRematchAcceptedRef.current?.(updatedRoom.rematch_room_id);
        return;
      }

      // Update rematch status
      if (updatedRoom.rematch_requested_by) {
        setRematchStatus(updatedRoom.rematch_requested_by === userIdRef.current ? 'requested' : 'received');
      } else {
        setRematchStatus('none');
      }

      // Notify game finished
      onGameFinishedRef.current?.(updatedRoom);
    }
  }, [setStatus]);

  // Handle rematch room transition
  const handleRematchAccepted = useCallback(async (newRoomId: string) => {
    const newRoom = await gameRoomService.getRoom(newRoomId);
    if (newRoom) {
      cleanupSubscription();
      setRoom(newRoom);
      setStatus('playing');
      setError(null);
      setRematchStatus('none');
      subscribeToRoomRef.current?.(newRoomId);
    }
  }, [cleanupSubscription, setStatus]);
  handleRematchAcceptedRef.current = handleRematchAccepted;

  // Subscribe to room updates
  const subscribeToRoom = useCallback((roomId: string) => {
    unsubscribeRef.current = gameRoomService.subscribeToRoom(
      roomId,
      handleRoomUpdate,
      handleSubscriptionError,
      handleConnectionStatus
    );
  }, [handleRoomUpdate, handleSubscriptionError, handleConnectionStatus]);
  subscribeToRoomRef.current = subscribeToRoom;

  // Initialize game room helper
  const initializeGameRoom = useCallback(async (
    newRoom: GameRoom,
    initialStatus?: OnlineGameStatus
  ) => {
    const roomWithPlayers = await gameRoomService.getRoom(newRoom.id);

    if (roomWithPlayers) {
      setRoom(roomWithPlayers);
    } else {
      setRoom({
        ...newRoom,
        player1: undefined,
        player2: undefined,
      } as GameRoomWithPlayers);
    }

    const roomStatus = initialStatus ?? (newRoom.status === 'waiting' ? 'waiting' : 'playing');
    setStatus(roomStatus);
    subscribeToRoom(newRoom.id);
  }, [setStatus, subscribeToRoom]);

  // Find public match
  const findMatch = useCallback(async () => {
    if (!userId) {
      log.error('findMatch called without userId');
      setError('Usuario no autenticado');
      setStatus('idle');
      return;
    }

    setError(null);
    setStatus('searching');
    cleanupSubscription();

    try {
      log.log('Finding match for user:', userId);
      const newRoom = await gameRoomService.findOrCreateMatch(userId, gameType);

      if (!newRoom) {
        log.error('findOrCreateMatch returned null');
        setError('Error al buscar partida');
        setStatus('idle');
        return;
      }

      log.log('Got room:', newRoom.id, 'status:', newRoom.status);
      await initializeGameRoom(newRoom);
    } catch (err) {
      log.error('Error finding match:', err);
      setError('No se pudo conectar al servidor de matchmaking');
      setStatus('idle');
    }
  }, [userId, gameType, initializeGameRoom, cleanupSubscription, setStatus]);

  // Create private room
  const createPrivateRoom = useCallback(async () => {
    if (!userId) {
      log.error('createPrivateRoom called without userId');
      setError('Usuario no autenticado');
      setStatus('idle');
      return;
    }

    setError(null);
    setStatus('waiting');
    cleanupSubscription();

    try {
      log.log('Creating private room for user:', userId);
      const newRoom = await gameRoomService.createPrivateRoom(userId, gameType);

      if (!newRoom) {
        log.error('createPrivateRoom returned null');
        setError('Error al crear sala privada');
        setStatus('idle');
        return;
      }

      log.log('Created private room:', newRoom.id);
      await initializeGameRoom(newRoom, 'waiting');
    } catch (err) {
      log.error('Error creating private room:', err);
      setError('No se pudo crear la sala. Intenta de nuevo.');
      setStatus('idle');
    }
  }, [userId, gameType, initializeGameRoom, cleanupSubscription, setStatus]);

  // Find match with bet (new negotiation system)
  // Bet is NOT deducted until negotiation completes
  const findMatchWithBet = useCallback(async (amount: number): Promise<boolean> => {
    if (!userId) {
      log.error('findMatchWithBet called without userId');
      setError('Usuario no autenticado');
      setStatus('idle');
      return false;
    }

    if (amount <= 0) {
      setError('Monto de apuesta invalido');
      return false;
    }

    // Verify balance without deducting
    const walletStore = useWalletStore.getState();
    const balance = walletStore.wallet?.balance ?? 0;
    if (amount > balance) {
      setError('Balance insuficiente para esta apuesta');
      return false;
    }

    setError(null);
    setStatus('searching');
    cleanupSubscription();

    try {
      log.log('Finding match with negotiation for user:', userId, 'amount:', amount);
      // Use new v2 matchmaking with negotiation
      const newRoom = await gameRoomService.findOrCreateMatchWithNegotiation(userId, gameType, { wantsToBet: true, betAmount: amount });

      if (!newRoom) {
        log.error('findOrCreateMatchWithNegotiation returned null');
        setError('Error al buscar partida');
        setStatus('idle');
        return false;
      }

      log.log('Got room:', newRoom.id, 'status:', newRoom.status, 'metadata:', newRoom.metadata);

      // Check negotiation state from room metadata
      const metadata = newRoom.metadata as GameRoomMetadata | null;
      const negotiationState = metadata?.negotiation_state;

      if (negotiationState === 'agreed' && metadata?.bet_amount) {
        // Both players agreed on the same amount — the server already debited both
        // stakes atomically when it set 'agreed'. Reflect the amount and refresh
        // the (now server-debited) balance. If a player couldn't cover it the
        // server would have returned 'no_bet' instead, so 'agreed' is trustworthy.
        betDeductedForRoomRef.current = newRoom.id;
        setBetAmount(metadata.bet_amount);
        walletStore.refreshWallet();
      } else if (negotiationState === 'pending') {
        // Need to negotiate - don't deduct yet
        log.log('Entering negotiation phase');
      }
      // For 'none' or 'no_bet', no bet to deduct

      await initializeGameRoom(newRoom);
      return true;
    } catch (err) {
      log.error('Error finding match:', err);
      setError('No se pudo conectar al servidor de matchmaking');
      setStatus('idle');
      return false;
    }
  }, [userId, gameType, initializeGameRoom, cleanupSubscription, setStatus]);

  // Create private room with bet (new negotiation system)
  // Bet is NOT deducted until negotiation completes with the joiner
  const createPrivateRoomWithBet = useCallback(async (amount: number): Promise<boolean> => {
    if (!userId) {
      log.error('createPrivateRoomWithBet called without userId');
      setError('Usuario no autenticado');
      setStatus('idle');
      return false;
    }

    if (amount <= 0) {
      setError('Monto de apuesta invalido');
      return false;
    }

    // Verify balance without deducting
    const walletStore = useWalletStore.getState();
    const balance = walletStore.wallet?.balance ?? 0;
    if (amount > balance) {
      setError('Balance insuficiente para esta apuesta');
      return false;
    }

    setError(null);
    setStatus('waiting');
    cleanupSubscription();

    try {
      log.log('Creating private room with negotiation for user:', userId, 'amount:', amount);
      // Use new negotiation system - bet stored as proposal, not deducted
      const newRoom = await gameRoomService.createPrivateRoomWithNegotiation(userId, gameType, { wantsToBet: true, betAmount: amount });

      if (!newRoom) {
        log.error('createPrivateRoomWithNegotiation returned null');
        setError('Error al crear sala privada');
        setStatus('idle');
        return false;
      }

      log.log('Created private room with negotiation:', newRoom.id);
      await initializeGameRoom(newRoom, 'waiting');
      return true;
    } catch (err) {
      log.error('Error creating private room:', err);
      setError('No se pudo crear la sala. Intenta de nuevo.');
      setStatus('idle');
      return false;
    }
  }, [userId, gameType, initializeGameRoom, cleanupSubscription, setStatus]);

  // Join room by ID
  const joinRoom = useCallback(async (roomId: string) => {
    if (!userId) {
      log.error('joinRoom called without userId');
      setError('Usuario no autenticado');
      setStatus('idle');
      return;
    }

    setError(null);
    setStatus('searching');
    cleanupSubscription();

    try {
      log.log('Joining room:', roomId, 'for user:', userId);
      const { room: newRoom, error: joinError } = await gameRoomService.joinRoomById(roomId, userId);

      if (joinError || !newRoom) {
        log.error('joinRoomById error:', joinError);
        setError(joinError || 'Error al unirse a la sala');
        setStatus('idle');
        return;
      }

      log.log('Joined room:', newRoom.id, 'status:', newRoom.status);
      await initializeGameRoom(newRoom);
    } catch (err) {
      log.error('Error joining room:', err);
      setError('No se pudo unir a la sala. Verifica el enlace.');
      setStatus('idle');
    }
  }, [userId, initializeGameRoom, cleanupSubscription, setStatus]);

  // Leave game with retry logic
  const leaveGame = useCallback(async () => {
    const currentBetAmount = betAmountRef.current;
    const currentStatus = statusRef.current;
    const currentRoom = room;

    // Refund bet if leaving an unfinished room. The server validates the stake
    // from the room metadata and refunds at most once (shares the settlement key).
    if (
      currentBetAmount &&
      currentBetAmount > 0 &&
      currentRoom &&
      (currentStatus === 'searching' || currentStatus === 'waiting')
    ) {
      log.log('Refunding bet on leave:', currentBetAmount);
      const walletStore = useWalletStore.getState();
      try {
        await walletStore.cancelBet(currentRoom.id);
      } catch (err) {
        log.error('Error refunding bet on leave:', err);
      }
    }

    // Always cleanup subscription first (this always works locally)
    cleanupSubscription();

    // Try to leave room on server with retry logic
    if (currentRoom) {
      let retries = 3;
      while (retries > 0) {
        try {
          const success = await gameRoomService.leaveRoom(currentRoom.id, userId);
          if (success) {
            log.log('Successfully left room');
            break;
          }
          log.warn(`leaveRoom failed, retries left: ${retries - 1}`);
        } catch (err) {
          log.error('Error leaving room:', err);
        }
        retries--;
        if (retries > 0) {
          await new Promise(r => setTimeout(r, 500)); // Wait before retry
        }
      }
    }

    // Reset state regardless of server response
    setRoom(null);
    setStatus('idle');
    setError(null);
    setRematchStatus('none');
    setBetAmount(null);
    betDeductedForRoomRef.current = null; // Reset bet tracking
    betSettledForRoomRef.current = null; // Reset settlement tracking
    pollFailureCountRef.current = 0; // Reset poll failure count
  }, [room, userId, cleanupSubscription, setStatus]);

  // Update room (for game-specific updates)
  const updateRoom = useCallback(async (updates: Partial<GameRoom>): Promise<boolean> => {
    if (!room) return false;

    // This would be implemented based on specific needs
    // For now, it's a placeholder for game-specific updates
    log.log('updateRoom called with:', updates);
    return true;
  }, [room]);

  // Request rematch
  const requestRematch = useCallback(async () => {
    if (!room || status !== 'finished') {
      log.error('requestRematch: invalid state');
      return;
    }

    log.log('Requesting rematch for room:', room.id);
    const success = await gameRoomService.requestRematch(room.id, userId);

    if (success) {
      setRematchStatus('requested');
    } else {
      setError('Error al solicitar revancha');
    }
  }, [room, status, userId]);

  // Accept rematch
  const acceptRematch = useCallback(async () => {
    if (!room || status !== 'finished' || rematchStatus !== 'received') {
      log.error('acceptRematch: invalid state');
      return;
    }

    log.log('Accepting rematch for room:', room.id);
    const newRoom = await gameRoomService.acceptRematch(room.id, userId);

    if (newRoom) {
      setRematchStatus('accepted');
      cleanupSubscription();

      const roomWithPlayers = await gameRoomService.getRoom(newRoom.id);
      if (roomWithPlayers) {
        setRoom(roomWithPlayers);
      } else {
        setRoom({
          ...newRoom,
          player1: undefined,
          player2: undefined,
        } as GameRoomWithPlayers);
      }

      setStatus('playing');
      setError(null);
      setRematchStatus('none');
      subscribeToRoom(newRoom.id);
    } else {
      setError('Error al aceptar revancha');
    }
  }, [room, status, rematchStatus, userId, cleanupSubscription, setStatus, subscribeToRoom]);

  // Decline rematch
  const declineRematch = useCallback(async () => {
    if (!room || status !== 'finished') {
      log.error('declineRematch: invalid state');
      return;
    }

    log.log('Declining rematch for room:', room.id);
    await gameRoomService.declineRematch(room.id);
    setRematchStatus('none');
  }, [room, status]);

  // Submit bet proposal during negotiation
  const submitBetProposal = useCallback(async (amount: number) => {
    if (!room || status !== 'negotiating') {
      log.error('submitBetProposal: invalid state, status:', status);
      return;
    }

    const walletStore = useWalletStore.getState();
    const balance = walletStore.wallet?.balance ?? 0;

    if (amount > balance) {
      setError('Balance insuficiente para esta propuesta');
      return;
    }

    try {
      log.log('Submitting bet proposal:', amount);
      const updatedRoom = await gameRoomService.submitBetProposal(room.id, userId, amount);

      if (updatedRoom) {
        const metadata = updatedRoom.metadata as GameRoomMetadata | null;
        if (metadata?.negotiation_state === 'agreed') {
          // Agreement reached — the server already debited both stakes atomically.
          betDeductedForRoomRef.current = room.id;
          setBetAmount(amount);
          setStatus('playing');
          walletStore.refreshWallet();
        } else if (metadata?.negotiation_state === 'no_bet') {
          // Server declined the bet (a player couldn't cover it) — play unstaked.
          setBetAmount(null);
          setStatus('playing');
        }
      }
    } catch (err) {
      log.error('Error submitting bet proposal:', err);
      setError('Error al enviar propuesta');
    }
  }, [room, status, userId, setStatus]);

  // Accept opponent's bet proposal
  const acceptBetProposal = useCallback(async () => {
    if (!room || status !== 'negotiating' || !negotiation.opponentProposal) {
      log.error('acceptBetProposal: invalid state');
      return;
    }

    const walletStore = useWalletStore.getState();
    const balance = walletStore.wallet?.balance ?? 0;
    const amount = negotiation.opponentProposal;

    if (amount > balance) {
      setError('Balance insuficiente para aceptar esta apuesta');
      return;
    }

    try {
      log.log('Accepting bet proposal:', amount);
      const updatedRoom = await gameRoomService.acceptBetProposal(room.id, userId);

      if (updatedRoom) {
        const state = (updatedRoom.metadata as GameRoomMetadata | null)?.negotiation_state;
        if (state === 'agreed') {
          // The server debited both stakes atomically when it set 'agreed'.
          betDeductedForRoomRef.current = room.id;
          setBetAmount(amount);
          setStatus('playing');
          walletStore.refreshWallet();
        } else {
          // Server declined the bet (a player couldn't cover it) — play unstaked.
          setBetAmount(null);
          setStatus('playing');
        }
      }
    } catch (err) {
      log.error('Error accepting bet proposal:', err);
      setError('Error al aceptar propuesta');
    }
  }, [room, status, userId, negotiation.opponentProposal, setStatus]);

  // Skip betting and start game without bet
  const skipBetting = useCallback(async () => {
    if (!room || status !== 'negotiating') {
      log.error('skipBetting: invalid state');
      return;
    }

    try {
      log.log('Skipping betting for room:', room.id);
      await gameRoomService.skipBetting(room.id, userId);
      setBetAmount(null);
      setStatus('playing');
    } catch (err) {
      log.error('Error skipping betting:', err);
      setError('Error al saltar apuesta');
    }
  }, [room, status, userId, setStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupSubscription();
    };
  }, [cleanupSubscription]);

  // Polling fallback when waiting and realtime not connected
  useEffect(() => {
    if (status !== 'waiting' || !room || connectionStatus === 'connected') return;

    log.log('Starting polling fallback for room:', room.id);

    const pollInterval = setInterval(async () => {
      try {
        const updatedRoom = await gameRoomService.getRoom(room.id);
        log.log('Poll result:', updatedRoom?.status);

        if (updatedRoom && updatedRoom.status === 'playing') {
          log.log('Opponent joined via polling');
          setRoom(updatedRoom);
          setStatus('playing');
        }
      } catch (err) {
        log.error('Polling error:', err);
      }
    }, 3000);

    return () => {
      log.log('Stopping polling');
      clearInterval(pollInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- room?.id is intentional to avoid restarting polling on every room update
  }, [status, room?.id, connectionStatus, setStatus]);

  // Timeout for 'searching' state
  useEffect(() => {
    if (status !== 'searching') return;

    log.log('Starting search timeout timer');
    const timeoutId = setTimeout(() => {
      log.warn('Search timeout reached');
      setError('No se encontro oponente. Intenta de nuevo.');
      cleanupSubscription();
      setStatus('idle');
    }, SEARCH_TIMEOUT_MS);

    return () => clearTimeout(timeoutId);
  }, [status, cleanupSubscription, setStatus]);

  // Timeout for 'waiting' state (private room max wait)
  useEffect(() => {
    if (status !== 'waiting') return;

    log.log('Starting waiting timeout timer');
    const timeoutId = setTimeout(async () => {
      log.warn('Waiting timeout reached');
      setError('Tiempo de espera agotado. La sala ha expirado.');
      cleanupSubscription();
      if (room) {
        try {
          await gameRoomService.leaveRoom(room.id, userIdRef.current);
        } catch (err) {
          log.error('Error leaving room on timeout:', err);
        }
      }
      setRoom(null);
      setStatus('idle');
    }, WAITING_TIMEOUT_MS);

    return () => clearTimeout(timeoutId);
  }, [status, room, cleanupSubscription, setStatus]);

  // Timeout for 'negotiating' state with server-side check
  useEffect(() => {
    if (status !== 'negotiating' || !room) return;

    log.log('Starting negotiation timeout check');

    // Periodic check with server
    const checkInterval = setInterval(async () => {
      try {
        const updatedRoom = await gameRoomService.checkNegotiationTimeout(room.id);
        if (updatedRoom && updatedRoom.status === 'playing') {
          log.log('Negotiation timeout enforced by server');
          setRoom(prev => prev ? { ...prev, ...updatedRoom } : null);
          setStatus('playing');
        }
      } catch (err) {
        log.error('Error checking negotiation timeout:', err);
      }
    }, 5000);

    // Hard client-side timeout as backup
    const timeoutId = setTimeout(async () => {
      log.warn('Negotiation client timeout - forcing skip');
      try {
        await gameRoomService.skipBetting(room.id, userIdRef.current);
        setStatus('playing');
      } catch (err) {
        log.error('Error forcing skip betting:', err);
      }
    }, NEGOTIATION_TIMEOUT_MS + 5000); // 5s buffer after server timeout

    return () => {
      clearInterval(checkInterval);
      clearTimeout(timeoutId);
    };
  }, [status, room, setStatus]);

  // Polling fallback for 'playing' state when disconnected
  useEffect(() => {
    if (status !== 'playing' || !room || connectionStatus === 'connected') {
      pollFailureCountRef.current = 0; // Reset on state change
      return;
    }

    // Circuit breaker check
    if (pollFailureCountRef.current >= MAX_POLL_FAILURES) {
      log.error('Circuit breaker triggered - too many poll failures');
      setError('Conexion perdida. Por favor reconecta.');
      return;
    }

    log.log('Starting playing-state polling fallback');

    const pollInterval = setInterval(async () => {
      try {
        const updatedRoom = await gameRoomService.getRoom(room.id);

        if (!updatedRoom) {
          pollFailureCountRef.current++;
          log.warn(`Poll failure ${pollFailureCountRef.current}/${MAX_POLL_FAILURES}`);
          return;
        }

        // Reset failure count on success
        pollFailureCountRef.current = 0;

        const currentTime = room.updated_at ? new Date(room.updated_at).getTime() : 0;
        const newTime = updatedRoom.updated_at ? new Date(updatedRoom.updated_at).getTime() : 0;

        if (newTime > currentTime) {
          log.log('Playing-state polling detected change');
          setRoom(prev => prev ? { ...prev, ...updatedRoom } : null);
          handleRoomUpdate(updatedRoom);
        }
      } catch (err) {
        pollFailureCountRef.current++;
        log.error(`Playing-state polling error (${pollFailureCountRef.current}/${MAX_POLL_FAILURES}):`, err);
      }
    }, 3000);

    return () => {
      log.log('Stopping playing-state polling');
      clearInterval(pollInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- room?.id and room?.updated_at are intentional to avoid re-running on every room property change
  }, [status, room?.id, room?.updated_at, connectionStatus, handleRoomUpdate]);

  // Calculate pot total
  const potTotal = betAmount ? betAmount * 2 : 0;
  const isPrivateRoom = room?.is_private ?? false;

  return {
    // State
    status,
    room,
    error,
    connectionStatus,
    rematchStatus,
    betAmount,
    potTotal,
    isPrivateRoom,
    negotiation,

    // Actions - Matchmaking
    findMatch,
    createPrivateRoom,
    joinRoom,
    findMatchWithBet,
    createPrivateRoomWithBet,

    // Actions - Game
    leaveGame,
    updateRoom,

    // Actions - Rematch
    requestRematch,
    acceptRematch,
    declineRematch,

    // Actions - Negotiation
    submitBetProposal,
    acceptBetProposal,
    skipBetting,

    // Internal
    setStatus,
    setRoom,
    setError,
    cleanupSubscription,
    subscribeToRoom,
    statusRef,
    userIdRef,
  };
}

export default useOnlineGameCore;
