import 'server-only';
import Ably from 'ably';

// Server-side Ably REST client. Room updates are published here (from server
// actions) so subscribed clients get them over websockets — real realtime, not
// polling. Best-effort: if ABLY_API_KEY is unset it no-ops, and the client's
// polling fallback still covers updates.
let rest: Ably.Rest | null = null;

function getRest(): Ably.Rest | null {
  const key = process.env.ABLY_API_KEY;
  if (!key) return null;
  if (!rest) rest = new Ably.Rest(key);
  return rest;
}

export function realtimeEnabled(): boolean {
  return Boolean(process.env.ABLY_API_KEY);
}

export async function publishRoom(room: { id: string } | null): Promise<void> {
  if (!room) return;
  const client = getRest();
  if (!client) return;
  try {
    await client.channels.get(`room:${room.id}`).publish('update', room);
  } catch {
    // Realtime delivery is best-effort; the client polling fallback covers gaps.
  }
}
