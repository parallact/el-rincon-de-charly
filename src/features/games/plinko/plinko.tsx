'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { useWalletStore } from '@/features/wallet';
import type { GameProps } from '../registry/types';
import { usePlinkoGame } from './hooks';

// Dynamically import GameScreen to avoid SSR issues with Matter.js
const GameScreen = dynamic(
  () => import('./components/game-screen').then((mod) => mod.GameScreen),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-(--color-primary)"></div>
      </div>
    ),
  }
);

type PlinkoProps = Partial<GameProps>;

export function Plinko({ onBack = () => {} }: PlinkoProps) {
  const [isReady, setIsReady] = useState(false);

  const { user, isLoading: isAuthLoading } = useAuth();
  const { wallet, loadWallet, isLoading: isWalletLoading } = useWalletStore();

  const isAuthenticated = !!user;

  // Load wallet when authenticated
  useEffect(() => {
    if (user?.id && !wallet && !isWalletLoading) {
      loadWallet(user.id);
    }
  }, [user?.id, wallet, isWalletLoading, loadWallet]);

  // Mark as ready when auth check is complete
  // For authenticated users, we wait for wallet loading to finish (success or fail)
  useEffect(() => {
    if (isAuthLoading) return;

    if (!user) {
      setIsReady(true); // eslint-disable-line react-hooks/set-state-in-effect -- state sync after auth check
      return;
    }

    if (!isWalletLoading) {
      setIsReady(true);  
    }
  }, [isAuthLoading, isWalletLoading, user]);

  const game = usePlinkoGame({
    initialRows: 12,
  });

  // Loading state
  if (!isReady) {
    return (
      <div className="game-container flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-(--color-primary)"></div>
          <span className="text-sm text-(--color-text-muted)">Cargando...</span>
        </div>
      </div>
    );
  }

  // Direct game view (no menu)
  return (
    <GameScreen
      rows={game.rows}
      speed={game.speed}
      betAmount={game.betAmount}
      ballCount={game.ballCount}
      balance={game.balance}
      gameState={game.gameState}
      currentResult={game.currentResult}
      history={game.history}
      totalProfit={game.totalProfit}
      dropsCount={game.dropsCount}
      isAuthenticated={isAuthenticated}
      onRowsChange={game.setRows}
      onSpeedChange={game.setSpeed}
      onBetChange={game.setBetAmount}
      onBallCountChange={game.setBallCount}
      onDrop={game.dropBalls}
      onBallLanded={game.onBallLanded}
      onBack={onBack}
    />
  );
}

export default Plinko;
