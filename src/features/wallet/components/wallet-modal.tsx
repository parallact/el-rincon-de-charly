'use client';

import { useState, useEffect } from 'react';
import {
  Coins,
  History,
  Plus,
  ArrowUpRight,
  ArrowDownLeft,
  Gift,
  RotateCcw,
  TrendingUp,
} from 'lucide-react';
import { useWalletStore, formatBalance } from '../store/wallet-store';
import type { TransactionType } from '../types';
import { cn } from '@/lib/utils/cn';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalTitle,
  ModalDescription,
} from '@/components/ui/modal';
import { Button } from '@/components/ui/button';

interface WalletModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const transactionIcons: Record<TransactionType, typeof ArrowUpRight> = {
  deposit: ArrowDownLeft,
  withdraw: ArrowUpRight,
  bet: ArrowUpRight,
  win: TrendingUp,
  bonus: Gift,
  refund: RotateCcw,
};

const transactionColors: Record<TransactionType, string> = {
  deposit: 'text-(--color-success)',
  withdraw: 'text-(--color-error)',
  bet: 'text-(--color-error)',
  win: 'text-(--color-success)',
  bonus: 'text-(--color-warning)',
  refund: 'text-(--color-accent)',
};

const transactionLabels: Record<TransactionType, string> = {
  deposit: 'Deposito',
  withdraw: 'Retiro',
  bet: 'Apuesta',
  win: 'Ganancia',
  bonus: 'Bonificacion',
  refund: 'Reembolso',
};

export function WalletModal({ isOpen, onClose }: WalletModalProps) {
  const [activeTab, setActiveTab] = useState<'balance' | 'history'>('balance');
  const [isAddingCredits, setIsAddingCredits] = useState(false);
  const {
    wallet,
    transactions,
    loadTransactions,
    loadMoreTransactions,
    isLoadingMore,
    hasMoreTransactions,
    claimDailyBonus,
    error,
  } = useWalletStore();

  useEffect(() => {
    if (isOpen && wallet) {
      loadTransactions();
    }
  }, [isOpen, wallet, loadTransactions]);

  const handleAddCredits = async () => {
    setIsAddingCredits(true);
    try {
      // Server enforces the once-per-24h limit; the button shows the error toast
      // (e.g. "already claimed") via the store's `error` state if not eligible.
      await claimDailyBonus();
    } finally {
      setIsAddingCredits(false);
    }
  };

  return (
    <Modal open={isOpen} onClose={onClose}>
      <ModalContent size="default">
        {/* Header */}
        <ModalHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-(--color-warning)/10 border border-(--color-warning)/30 flex items-center justify-center">
              <Coins className="text-(--color-warning)" size={20} />
            </div>
            <div>
              <ModalTitle className="font-heading font-bold text-lg text-(--color-text)">
                Mi Billetera
              </ModalTitle>
              <ModalDescription className="text-sm text-(--color-text-muted)">
                Creditos virtuales
              </ModalDescription>
            </div>
          </div>
        </ModalHeader>

        {/* Tabs */}
        <div className="px-5 py-3 border-b border-(--color-border)">
          <div className="flex bg-(--color-background) rounded-lg p-1">
            <button
              onClick={() => setActiveTab('balance')}
              className={cn(
                'flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors',
                'flex items-center justify-center gap-2',
                activeTab === 'balance'
                  ? 'bg-(--color-primary) text-white'
                  : 'text-(--color-text-muted) hover:text-(--color-text)'
              )}
            >
              <Coins size={16} />
              Balance
            </button>
            <button
              onClick={() => setActiveTab('history')}
              className={cn(
                'flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors',
                'flex items-center justify-center gap-2',
                activeTab === 'history'
                  ? 'bg-(--color-primary) text-white'
                  : 'text-(--color-text-muted) hover:text-(--color-text)'
              )}
            >
              <History size={16} />
              Historial
            </button>
          </div>
        </div>

        {/* Content */}
        <ModalBody>
          {activeTab === 'balance' ? (
            <div className="space-y-4">
              {/* Balance Display */}
              <div className="text-center py-5 px-4 rounded-xl bg-(--color-background) border border-(--color-border)">
                <p className="text-sm text-(--color-text-muted) mb-1">
                  Balance actual
                </p>
                <p className="text-3xl font-heading font-bold text-(--color-primary)">
                  {formatBalance(wallet?.balance ?? 0)}
                </p>
              </div>

              {error && (
                <div className="p-3 rounded-lg bg-(--color-error)/10 text-(--color-error) text-sm text-center border border-(--color-error)/30">
                  {error}
                </div>
              )}

              {/* Add Credits */}
              <Button
                variant="primary"
                className="w-full"
                size="lg"
                onClick={handleAddCredits}
                disabled={isAddingCredits}
                loading={isAddingCredits}
                icon={<Plus size={20} />}
              >
                Obtener 1000 creditos gratis
              </Button>

              <p className="text-xs text-center text-(--color-text-subtle)">
                Los creditos son virtuales y no tienen valor monetario real.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {transactions.length === 0 ? (
                <div className="text-center py-12">
                  <History
                    className="mx-auto text-(--color-text-subtle) mb-3"
                    size={40}
                  />
                  <p className="text-(--color-text-muted)">
                    No hay transacciones aun
                  </p>
                </div>
              ) : (
                <>
                  {transactions.map((tx) => {
                    const Icon = transactionIcons[tx.type];
                    const colorClass = transactionColors[tx.type];
                    const isPositive = tx.amount > 0;

                    return (
                      <div
                        key={tx.id}
                        className="flex items-center gap-3 p-3 rounded-lg bg-(--color-background) border border-(--color-border)"
                      >
                        <div
                          className={cn(
                            'w-10 h-10 rounded-lg flex items-center justify-center',
                            isPositive
                              ? 'bg-(--color-success)/10'
                              : 'bg-(--color-error)/10'
                          )}
                        >
                          <Icon size={18} className={colorClass} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm text-(--color-text) truncate">
                            {tx.description || transactionLabels[tx.type]}
                          </p>
                          <p className="text-xs text-(--color-text-muted)">
                            {new Date(tx.createdAt).toLocaleDateString('es-AR', {
                              day: 'numeric',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className={cn('font-bold', colorClass)}>
                            {isPositive ? '+' : ''}
                            {formatBalance(tx.amount)}
                          </p>
                        </div>
                      </div>
                    );
                  })}

                  {/* Load More Button */}
                  {hasMoreTransactions && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full mt-3"
                      onClick={() => loadMoreTransactions()}
                      disabled={isLoadingMore}
                      loading={isLoadingMore}
                    >
                      {isLoadingMore ? 'Cargando...' : 'Cargar más'}
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

export default WalletModal;
