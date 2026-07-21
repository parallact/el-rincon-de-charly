import Ably from 'ably';
import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';

// Mints a short-lived Ably token for the signed-in user, scoped to a SINGLE room.
//
// The token grants `subscribe` on `room:<roomId>` only when the caller is a
// participant of that room (player1/player2) or the room is a public room still
// waiting for an opponent (spectatable, no private negotiation yet). This replaces
// the previous `room:*` grant, which let any authenticated user subscribe to any
// room's live feed — including two other players' private bet negotiation.
//
// Publishing is never granted to clients; all room updates are published
// server-side (REST, full key) from the game actions.
export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const key = process.env.ABLY_API_KEY;
  if (!key) {
    return NextResponse.json({ error: 'Realtime not configured' }, { status: 503 });
  }

  const roomId = req.nextUrl.searchParams.get('roomId');

  // Default: a private per-user channel that nobody publishes to. This lets the
  // connection establish before any room is selected without exposing any room.
  let capability: Record<string, Ably.capabilityOp[]> = { [`user:${userId}`]: ['subscribe'] };

  if (roomId) {
    const room = await prisma.gameRoom.findUnique({
      where: { id: roomId },
      select: { player1Id: true, player2Id: true, isPrivate: true, status: true },
    });
    const isParticipant = !!room && (room.player1Id === userId || room.player2Id === userId);
    // A public room still waiting for its second player carries no private
    // two-player negotiation, so it may be watched by any signed-in user.
    const isWatchablePublic = !!room && !room.isPrivate && room.status === 'waiting';
    if (isParticipant || isWatchablePublic) {
      capability = { [`room:${roomId}`]: ['subscribe'] };
    }
    // Otherwise fall through to the harmless per-user channel — no room access.
  }

  const client = new Ably.Rest(key);
  const tokenRequest = await client.auth.createTokenRequest({
    clientId: userId,
    capability,
  });
  return NextResponse.json(tokenRequest);
}
