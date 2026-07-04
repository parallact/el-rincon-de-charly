'use client';

import Ably from 'ably';

// Singleton browser Ably client. Authenticates via the NextAuth-gated token
// endpoint (subscribe-only capability). If realtime is not configured the auth
// request 503s and the client stays disconnected — the game's polling fallback
// then covers updates, so nothing hard-fails.
let client: Ably.Realtime | null = null;

export function getAblyClient(): Ably.Realtime | null {
  if (typeof window === 'undefined') return null;
  if (!client) {
    client = new Ably.Realtime({
      authUrl: '/api/ably/auth',
      autoConnect: true,
      // Don't spam reconnects when realtime isn't configured.
      disconnectedRetryTimeout: 15000,
      suspendedRetryTimeout: 30000,
    });
  }
  return client;
}
