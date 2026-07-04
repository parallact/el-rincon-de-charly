import 'server-only';
import { auth } from '@/auth';

/** Returns the signed-in user id, or null. */
export async function getUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}
