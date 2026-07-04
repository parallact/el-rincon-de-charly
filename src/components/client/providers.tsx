'use client';

import { type ReactNode, useEffect } from 'react';
import { SessionProvider } from 'next-auth/react';
import { Toaster } from 'sonner';
import { ThemeProvider } from './theme-provider';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { useStatsStore } from '@/features/profile/store/stats-store';
import { useWalletStore } from '@/features/wallet/store/wallet-store';

interface ProvidersProps {
  children: ReactNode;
}

// Initializes auth-dependent stores from the NextAuth session.
function AuthStoreInitializer() {
  const { user, isAuthenticated } = useAuth();
  const { setUserId, startPeriodicSync } = useStatsStore();
  const { loadWallet, reset: resetWallet } = useWalletStore();

  useEffect(() => {
    if (isAuthenticated && user?.id) {
      setUserId(user.id);
      const stopSync = startPeriodicSync();
      loadWallet(user.id);
      return () => {
        stopSync();
      };
    } else {
      setUserId(null);
      resetWallet();
    }
  }, [isAuthenticated, user?.id, setUserId, startPeriodicSync, loadWallet, resetWallet]);

  return null;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <SessionProvider>
      <ThemeProvider defaultTheme="ember">
        <AuthStoreInitializer />
        {children}
        <Toaster
          position="top-center"
          toastOptions={{
            style: {
              background: 'var(--color-surface)',
              color: 'var(--color-text)',
              border: '1px solid var(--color-text-muted)',
            },
          }}
        />
      </ThemeProvider>
    </SessionProvider>
  );
}

export default Providers;
