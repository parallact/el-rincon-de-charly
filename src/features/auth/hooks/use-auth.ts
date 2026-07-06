'use client';

import { useCallback, useMemo } from 'react';
import { useSession, signIn as naSignIn, signOut as naSignOut } from 'next-auth/react';
import type { AuthUser, Profile } from '../types';
import { updateProfileAction } from '../actions/profile-actions';

type AuthError = { message: string };

// NextAuth-backed auth hook. Keeps the same shape the app consumed from the
// previous Supabase implementation so components don't change.
export function useAuth() {
  const { data: session, status } = useSession();

  const user: AuthUser | null = session?.user
    ? {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image,
      }
    : null;

  const isLoading = status === 'loading';
  const isAuthenticated = status === 'authenticated' && !!user;

  // Profile is derived from the session (username is stored as the user's name).
  const profile: Profile | null = user
    ? {
        id: user.id,
        username: user.name ?? null,
        avatar_url: user.image ?? null,
        games_played: 0,
        games_won: 0,
        win_rate: 0,
      }
    : null;

  const signIn = useCallback(
    async (email: string, password: string): Promise<{ error: AuthError | null }> => {
      const res = await naSignIn('credentials', { email, password, redirect: false });
      if (!res || res.error) {
        return { error: { message: 'Email o contraseña inválidos' } };
      }
      return { error: null };
    },
    []
  );

  const signUp = useCallback(
    async (email: string, password: string, username: string): Promise<{ error: AuthError | null }> => {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, username }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { error: { message: data.error || 'No se pudo crear la cuenta' } };
      }
      // Auto sign-in after registration.
      await naSignIn('credentials', { email, password, redirect: false });
      return { error: null };
    },
    []
  );

  const signInWithProvider = useCallback(
    async (provider: 'google'): Promise<{ error: AuthError | null }> => {
      await naSignIn(provider, { callbackUrl: '/games' });
      return { error: null };
    },
    []
  );

  const signOut = useCallback(async () => {
    await naSignOut({ redirect: false });
  }, []);

  const updateProfile = useCallback(
    async (updates: Partial<Profile>): Promise<{ error: AuthError | null }> => {
      if (!user) return { error: { message: 'Not authenticated' } };
      const result = await updateProfileAction({
        username: updates.username ?? undefined,
        avatarUrl: updates.avatar_url ?? undefined,
      });
      return { error: result.error ? { message: result.error } : null };
    },
    [user]
  );

  const fetchProfile = useCallback(async () => profile, [profile]);

  return useMemo(
    () => ({
      user,
      session,
      profile,
      isLoading,
      isAuthenticated,
      signIn,
      signUp,
      signInWithProvider,
      signOut,
      updateProfile,
      fetchProfile,
    }),
    [user, session, profile, isLoading, isAuthenticated, signIn, signUp, signInWithProvider, signOut, updateProfile, fetchProfile]
  );
}

export default useAuth;
