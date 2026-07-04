'use client';

import { useState, useCallback, useRef } from 'react';
import { useWalletStore } from '@/features/wallet';
import type { RowCount, PlinkoState, DropResult, BallDirection, BallSpeed } from '../types';
import { BALL_DROP_DELAY } from '../engine';
import { gameLogger } from '@/lib/utils/logger';

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

  // Actions
  setRows: (rows: RowCount) => void;
  setSpeed: (speed: BallSpeed) => void;
  setBetAmount: (amount: number) => void;
  setBallCount: (count: BallCount) => void;
  dropBalls: (dropBallFn: (id: string) => { path: BallDirection[]; finalSlot: number } | null) => Promise<boolean>;
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

  // Track pending bets
  const pendingBetsRef = useRef<Map<string, number>>(new Map());

  // Wallet
  const { wallet, placeBet, creditWin, isLoading: isWalletLoading } = useWalletStore();
  const balance = wallet?.balance ?? 0;

  // Calculate total bet
  const totalBet = betAmount * ballCount;

  const dropBalls = useCallback(async (
    dropBallFn: (id: string) => { path: BallDirection[]; finalSlot: number } | null
  ): Promise<boolean> => {
    // Validate balance for ALL balls
    if (totalBet > balance) {
      return false;
    }

    setGameState('dropping');

    // Drop all balls with delay between each
    for (let i = 0; i < ballCount; i++) {
      // Place bet for this ball
      const betSuccess = await placeBet(betAmount, 'plinko', `Apuesta en Plinko (${rows} filas)`);
      if (!betSuccess) {
        // If a bet fails mid-way, we still have some balls pending - don't reset state
        if (pendingBetsRef.current.size === 0) {
          setGameState('idle');
        }
        return false;
      }

      // Generate unique ball ID
      const ballId = `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;

      // Store the bet amount for this ball
      pendingBetsRef.current.set(ballId, betAmount);

      // Drop the ball
      const result = dropBallFn(ballId);
      if (!result) {
        // Refund if drop failed
        await creditWin(betAmount, 'plinko', 'Reembolso - error al soltar');
        pendingBetsRef.current.delete(ballId);
        continue; // Try next ball
      }

      // Add delay between balls (except for the last one)
      if (i < ballCount - 1) {
        await new Promise(resolve => setTimeout(resolve, BALL_DROP_DELAY));
      }
    }

    return true;
  }, [betAmount, ballCount, totalBet, balance, rows, placeBet, creditWin]);

  const onBallLanded = useCallback(async (
    ballId: string,
    slotIndex: number,
    multiplier: number
  ): Promise<void> => {
    const ballBetAmount = pendingBetsRef.current.get(ballId);
    if (ballBetAmount === undefined) {
      gameLogger.warn(`[Plinko] No pending bet found for ball ${ballId}`);
      return;
    }

    pendingBetsRef.current.delete(ballId);

    const winAmount = ballBetAmount * multiplier;
    const profit = winAmount - ballBetAmount;

    const result: DropResult = {
      betAmount: ballBetAmount,
      multiplier,
      winAmount,
      slotIndex,
    };

    // Record win (even if multiplier < 1, we still record the return)
    if (winAmount > 0) {
      await creditWin(winAmount, 'plinko', `Multiplicador x${multiplier}`);
    }

    setCurrentResult(result);
    setHistory(prev => [result, ...prev].slice(0, 50)); // Keep last 50 results
    setTotalProfit(prev => prev + profit);

    onDropComplete?.(result);

    // Check if all balls have landed
    if (pendingBetsRef.current.size === 0) {
      setGameState('finished');
      // Auto-reset to idle after a short delay
      setTimeout(() => setGameState('idle'), 1000);
    }
  }, [creditWin, onDropComplete]);

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
