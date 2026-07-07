'use client';

import { useState, useCallback, useRef } from 'react';
import { useWalletStore } from '@/features/wallet';
import type { RowCount, PlinkoState, DropResult, BallDirection, BallSpeed } from '../types';
import { BALL_DROP_DELAY } from '../engine';
import { dropPlinkoBallAction } from '../actions/plinko-actions';
import { gameLogger } from '@/lib/utils/logger';

// The server-decided outcome of one in-flight ball, keyed by ball id.
interface PendingBall {
  betAmount: number;
  multiplier: number;
  winAmount: number;
  slot: number;
}

// Ball count range
export const MIN_BALL_COUNT = 1;
export const MAX_BALL_COUNT = 10;
export type BallCount = number; // 1-10

interface UsePlinkoGameOptions {
  initialRows?: RowCount;
  onDropComplete?: (result: DropResult) => void;
}

interface UsePlinkoGameReturn {
  // State
  rows: RowCount;
  speed: BallSpeed;
  betAmount: number;
  ballCount: BallCount;
  gameState: PlinkoState;
  currentResult: DropResult | null;
  history: DropResult[];
  totalProfit: number;

  // Balance
  balance: number;
  isWalletLoading: boolean;

  // Derived
  totalBet: number;
  // Monotonic count of settled drops — used to refresh the fairness display.
  dropsCount: number;

  // Actions
  setRows: (rows: RowCount) => void;
  setSpeed: (speed: BallSpeed) => void;
  setBetAmount: (amount: number) => void;
  setBallCount: (count: BallCount) => void;
  dropBalls: (dropBallFn: (id: string, path?: BallDirection[]) => { path: BallDirection[]; finalSlot: number } | null) => Promise<boolean>;
  onBallLanded: (ballId: string, slotIndex: number, multiplier: number) => Promise<void>;
  reset: () => void;
}

export function usePlinkoGame(options: UsePlinkoGameOptions = {}): UsePlinkoGameReturn {
  const { initialRows = 12, onDropComplete } = options;

  // Game state
  const [rows, setRows] = useState<RowCount>(initialRows);
  const [speed, setSpeed] = useState<BallSpeed>('normal');
  const [betAmount, setBetAmount] = useState<number>(10);
  const [ballCount, setBallCount] = useState<BallCount>(1);
  const [gameState, setGameState] = useState<PlinkoState>('idle');
  const [currentResult, setCurrentResult] = useState<DropResult | null>(null);
  const [history, setHistory] = useState<DropResult[]>([]);
  const [totalProfit, setTotalProfit] = useState<number>(0);
  const [dropsCount, setDropsCount] = useState<number>(0);

  // Track in-flight balls and their server-decided outcomes.
  const pendingBetsRef = useRef<Map<string, PendingBall>>(new Map());

  // Wallet
  const { wallet, setWallet, isLoading: isWalletLoading } = useWalletStore();
  const balance = wallet?.balance ?? 0;

  // Calculate total bet
  const totalBet = betAmount * ballCount;

  // Finalize a ball once it lands (or immediately, if we couldn't animate it).
  // The outcome was already settled server-side, so this only updates the UI —
  // it uses the server-decided amounts stored when the ball was dropped.
  const finalizeBall = useCallback((ballId: string) => {
    const pending = pendingBetsRef.current.get(ballId);
    if (!pending) {
      gameLogger.warn(`[Plinko] No pending ball found for ${ballId}`);
      return;
    }
    pendingBetsRef.current.delete(ballId);

    const result: DropResult = {
      betAmount: pending.betAmount,
      multiplier: pending.multiplier,
      winAmount: pending.winAmount,
      slotIndex: pending.slot,
    };

    setCurrentResult(result);
    setHistory(prev => [result, ...prev].slice(0, 50)); // Keep last 50 results
    setTotalProfit(prev => prev + (pending.winAmount - pending.betAmount));

    onDropComplete?.(result);

    // Check if all balls have landed
    if (pendingBetsRef.current.size === 0) {
      setGameState('finished');
      setTimeout(() => setGameState('idle'), 1000);
    }
  }, [onDropComplete]);

  const dropBalls = useCallback(async (
    dropBallFn: (id: string, path?: BallDirection[]) => { path: BallDirection[]; finalSlot: number } | null
  ): Promise<boolean> => {
    // Quick client-side guard; the server also enforces the balance atomically.
    if (totalBet > balance) {
      return false;
    }

    setGameState('dropping');

    // Each drop is settled entirely server-side (provably fair): the server
    // decides the path/multiplier, debits the bet, and credits the win in one
    // atomic action. The client only animates the returned path — it never
    // asserts the amount.
    for (let i = 0; i < ballCount; i++) {
      const res = await dropPlinkoBallAction(betAmount, rows);
      if (res.error || !res.wallet) {
        gameLogger.warn(`[Plinko] Drop rejected: ${res.error ?? 'sin billetera'}`);
        if (pendingBetsRef.current.size === 0) {
          setGameState('idle');
        }
        return false;
      }

      // Authoritative balance (bet already debited + win credited).
      setWallet(res.wallet);
      // The server advanced the nonce for this drop; signal the fairness panel.
      setDropsCount((c) => c + 1);

      const ballId = `${res.nonce}-${i}-${Math.random().toString(36).slice(2, 8)}`;
      pendingBetsRef.current.set(ballId, {
        betAmount,
        multiplier: res.multiplier,
        winAmount: res.winAmount,
        slot: res.slot,
      });

      // Animate the server-decided path. If the engine can't drop (not ready),
      // the round is already settled — surface the result without animation.
      const dropped = dropBallFn(ballId, res.path);
      if (!dropped) {
        finalizeBall(ballId);
      }

      if (i < ballCount - 1) {
        await new Promise(resolve => setTimeout(resolve, BALL_DROP_DELAY));
      }
    }

    return true;
  }, [betAmount, ballCount, totalBet, balance, rows, setWallet, finalizeBall]);

  // Physics landing callback. The outcome is server-decided, so we ignore the
  // physics-reported slot/multiplier and finalize from the stored result.
  const onBallLanded = useCallback(async (ballId: string): Promise<void> => {
    finalizeBall(ballId);
  }, [finalizeBall]);

  const reset = useCallback(() => {
    setGameState('idle');
    setCurrentResult(null);
    setHistory([]);
    setTotalProfit(0);
    pendingBetsRef.current.clear();
  }, []);

  const handleSetRows = useCallback((newRows: RowCount) => {
    if (gameState !== 'dropping') {
      setRows(newRows);
    }
  }, [gameState]);

  const handleSetSpeed = useCallback((newSpeed: BallSpeed) => {
    if (gameState !== 'dropping') {
      setSpeed(newSpeed);
    }
  }, [gameState]);

  const handleSetBetAmount = useCallback((amount: number) => {
    if (amount >= 0 && gameState !== 'dropping') {
      setBetAmount(amount);
    }
  }, [gameState]);

  const handleSetBallCount = useCallback((count: BallCount) => {
    if (gameState !== 'dropping' && count >= MIN_BALL_COUNT && count <= MAX_BALL_COUNT) {
      setBallCount(count);
    }
  }, [gameState]);

  return {
    // State
    rows,
    speed,
    betAmount,
    ballCount,
    gameState,
    currentResult,
    history,
    totalProfit,

    // Balance
    balance,
    isWalletLoading,

    // Derived
    totalBet,
    dropsCount,

    // Actions
    setRows: handleSetRows,
    setSpeed: handleSetSpeed,
    setBetAmount: handleSetBetAmount,
    setBallCount: handleSetBallCount,
    dropBalls,
    onBallLanded,
    reset,
  };
}
