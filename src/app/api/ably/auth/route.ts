import Ably from 'ably';
import { NextResponse } from 'next/server';
import { auth } from '@/auth';

// Mints a short-lived Ably token for the signed-in user. Capability is
// subscribe-only on room:* so clients can receive room updates but never
// publish forged ones (all publishing happens server-side in the game actions).
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const key = process.env.ABLY_API_KEY;
  if (!key) {
    return NextResponse.json({ error: 'Realtime not configured' }, { status: 503 });
  }

  const client = new Ably.Rest(key);
  const tokenRequest = await client.auth.createTokenRequest({
    clientId: session.user.id,
    capability: { 'room:*': ['subscribe'] },
  });
  return NextResponse.json(tokenRequest);
}
