'use client';

import { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { formatBalance } from '@/features/wallet/store/wallet-store';
import type { RowCount, DropResult, BallDirection, BallSpeed } from '../../types';
import type { BallCount } from '../../hooks/use-plinko-game';
import { PlinkoCanvas } from '../plinko-canvas';
import { BetControls } from '../bet-controls';
import { FairnessPanel } from '../fairness-panel';
import { usePlinkoPhysics } from '../../hooks';

interface GameScreenProps {
  rows: RowCount;
  speed: BallSpeed;
  betAmount: number;
  ballCount: BallCount;
  balance: number;
  gameState: 'idle' | 'dropping' | 'finished';
  currentResult: DropResult | null;
  history: DropResult[];
  totalProfit: number;
  isAuthenticated: boolean;
  onRowsChange: (rows: RowCount) => void;
  onSpeedChange: (speed: BallSpeed) => void;
  onBetChange: (amount: number) => void;
  onBallCountChange: (count: BallCount) => void;
  onDrop: (dropFn: (id: string, path?: BallDirection[]) => { path: BallDirection[]; finalSlot: number } | null) => Promise<boolean>;
  onBallLanded: (ballId: string, slotIndex: number, multiplier: number) => Promise<void>;
  onBack: () => void;
}

export function GameScreen({
  rows,
  speed,
  betAmount,
  ballCount,
  balance,
  gameState,
  currentResult: _currentResult, // Reserved for future use
  history,
  totalProfit: _totalProfit, // Reserved for future use
  isAuthenticated,
  onRowsChange,
  onSpeedChange,
  onBetChange,
  onBallCountChange,
  onDrop,
  onBallLanded,
  onBack,
}: GameScreenProps) {
  void _currentResult;
  void _totalProfit;
  const [highlightedSlot, setHighlightedSlot] = useState<number | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [sessionSummary, setSessionSummary] = useState<{
    totalBet: number;
    totalWin: number;
    ballsCount: number;
  } | null>(null);

  // Show summary notification when game finishes (all balls landed)
  useEffect(() => {
    if (gameState === 'finished' && history.length > 0) {
      // Calculate summary from the balls that just landed (use ballCount from props)
      const recentResults = history.slice(0, ballCount);
      const totalBet = recentResults.reduce((sum, r) => sum + r.betAmount, 0);
      const totalWin = recentResults.reduce((sum, r) => sum + r.winAmount, 0);

      setSessionSummary({ // eslint-disable-line react-hooks/set-state-in-effect -- state update based on gameState transition
        totalBet,
        totalWin,
        ballsCount: recentResults.length,
      });
      setShowSummary(true);  

      const timer = setTimeout(() => setShowSummary(false), 4000);
      return () => clearTimeout(timer);
    }
  }, [gameState, history, ballCount]);

  const handleBallLanded = useCallback(async (ballId: string, slotIndex: number, multiplier: number) => {
    setHighlightedSlot(slotIndex);
    await onBallLanded(ballId, slotIndex, multiplier);

    // Clear highlight after delay
    setTimeout(() => {
      setHighlightedSlot(null);
    }, 1500);
  }, [onBallLanded]);

  const {
    canvasRef,
    dropBall,
    setRows: setPhysicsRows,
    setSpeed: setPhysicsSpeed,
    isReady,
    hasActiveBalls,
    error: physicsError,
  } = usePlinkoPhysics({
    rows,
    speed,
    onBallLanded: handleBallLanded,
  });

  const handleDrop = useCallback(async () => {
    await onDrop(dropBall);
  }, [onDrop, dropBall]);

  const handleRowsChange = useCallback((newRows: RowCount) => {
    if (!hasActiveBalls) {
      onRowsChange(newRows);
      setPhysicsRows(newRows);
    }
  }, [hasActiveBalls, onRowsChange, setPhysicsRows]);

  const handleSpeedChange = useCallback((newSpeed: BallSpeed) => {
    if (!hasActiveBalls) {
      onSpeedChange(newSpeed);
      setPhysicsSpeed(newSpeed);
    }
  }, [hasActiveBalls, onSpeedChange, setPhysicsSpeed]);

  const isDropping = gameState === 'dropping' || hasActiveBalls;

  return (
    <div className="game-container flex flex-col h-[calc(100dvh-4rem)] md:h-[calc(100dvh-1rem)] p-2 sm:p-4 lg:p-6">
      {/* Header - minimal */}
      <div className="flex items-center mb-2 sm:mb-3 lg:mb-4">
        <Button
          onClick={onBack}
          variant="ghost"
          size="sm"
          className="gap-1.5 text-(--color-text-muted) hover:text-(--color-text) h-8 sm:h-9"
        >
          <ArrowLeft size={16} className="sm:w-[18px] sm:h-[18px]" />
          <span className="hidden sm:inline">Volver</span>
        </Button>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col lg:flex-row gap-2 sm:gap-4 lg:gap-5 min-h-0">
        {/* Controls - Left on desktop, bottom on mobile */}
        <div className="w-full lg:w-[280px] xl:w-[300px] shrink-0 order-2 lg:order-1 flex flex-col gap-2 sm:gap-3">
          <div className="bg-(--color-surface) rounded-xl sm:rounded-2xl border border-(--color-border) p-3 sm:p-4 lg:p-5">
            <BetControls
              betAmount={betAmount}
              ballCount={ballCount}
              balance={balance}
              rows={rows}
              speed={speed}
              isDropping={isDropping}
              isAuthenticated={isAuthenticated}
              onBetChange={onBetChange}
              onBallCountChange={onBallCountChange}
              onRowsChange={handleRowsChange}
              onSpeedChange={handleSpeedChange}
              onDrop={handleDrop}
            />
          </div>
          {isAuthenticated && <FairnessPanel />}
        </div>

        {/* Game area - Right on desktop, top on mobile */}
        <div className="flex-1 order-1 lg:order-2 min-h-0 flex flex-col">
          {/* Canvas container - fills available space */}
          <div className="flex-1 relative bg-(--color-surface) rounded-xl sm:rounded-2xl border border-(--color-border) overflow-hidden min-h-[280px] sm:min-h-[350px] lg:min-h-[450px]">
            {/* Session summary notification - inside canvas, left side */}
            <AnimatePresence>
              {showSummary && sessionSummary && (
                <motion.div
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  className={cn(
                    'absolute top-1.5 left-1.5 sm:top-2 sm:left-2 z-20',
                    'px-2 py-1.5 sm:px-3 sm:py-2 rounded-lg text-center',
                    'bg-black/70 backdrop-blur-sm'
                  )}
                >
                  <div className="text-[9px] sm:text-[10px] text-white/70 mb-0.5 sm:mb-1">
                    {sessionSummary.ballsCount} {sessionSummary.ballsCount === 1 ? 'bola' : 'bolas'}
                  </div>
                  <div className={cn(
                    'text-xs sm:text-sm font-bold',
                    sessionSummary.totalWin >= sessionSummary.totalBet
                      ? 'text-(--color-success)'
                      : 'text-(--color-error)'
                  )}>
                    {sessionSummary.totalWin >= sessionSummary.totalBet ? '+' : ''}
                    {formatBalance(sessionSummary.totalWin - sessionSummary.totalBet)}
                  </div>
                  <div className="text-[9px] sm:text-[10px] text-white/60 mt-0.5">
                    {formatBalance(sessionSummary.totalBet)} → {formatBalance(sessionSummary.totalWin)}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            {/* Always render canvas so ref can be attached */}
            <PlinkoCanvas
              ref={canvasRef}
              rows={rows}
              highlightedSlot={highlightedSlot}
            />

            {/* Show spinner overlay while physics initializes */}
            {!isReady && !physicsError && (
              <div className="absolute inset-0 flex items-center justify-center bg-(--color-surface)">
                <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-(--color-primary)"></div>
              </div>
            )}

            {/* Show error message if physics initialization failed */}
            {physicsError && (
              <div className="absolute inset-0 flex items-center justify-center bg-(--color-surface) p-4">
                <div className="text-center">
                  <div className="text-(--color-error) text-lg font-semibold mb-2">
                    Error de renderizado
                  </div>
                  <div className="text-(--color-text-muted) text-sm mb-4">
                    No se pudo inicializar WebGL en tu navegador.
                  </div>
                  <Button
                    onClick={() => window.location.reload()}
                    variant="secondary"
                    size="sm"
                  >
                    Reintentar
                  </Button>
                </div>
              </div>
            )}

            {/* History - top-right with label */}
            {history.length > 0 && (
              <div className="absolute top-1 right-1 z-10 flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded bg-black/50">
                <span className="hidden sm:inline text-[8px] text-white/50 uppercase tracking-wide">Últimos</span>
                <div className="flex gap-0.5 sm:gap-1">
                  {history.slice(0, 8).map((result, index) => {
                    const isWin = result.multiplier >= 1;
                    return (
                      <span
                        key={index}
                        className="text-[8px] sm:text-[9px] font-bold"
                        style={{
                          color: isWin ? 'var(--color-success)' : 'var(--color-error)',
                        }}
                      >
                        {result.multiplier}×
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
