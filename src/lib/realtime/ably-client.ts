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

// The room the connection is currently authorized for, so we don't re-authorize
// (and churn the connection) when re-subscribing to the same room.
let authorizedRoomId: string | null = null;

// Re-authorize the connection with a token scoped to a single room. The auth
// endpoint only grants `room:<roomId>` when the caller is a participant (or the
// room is a public waiting room), so a client can never subscribe to a room it is
// not part of. Best-effort: on failure the caller's polling fallback covers gaps.
export function authorizeForRoom(roomId: string): void {
  const c = getAblyClient();
  if (!c || authorizedRoomId === roomId) return;
  authorizedRoomId = roomId;
  c.auth
    .authorize({}, { authUrl: '/api/ably/auth', authParams: { roomId } })
    .catch(() => {
      // Allow a later retry to re-authorize for this room.
      if (authorizedRoomId === roomId) authorizedRoomId = null;
    });
}
