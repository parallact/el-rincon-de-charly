import { redirect } from 'next/navigation';
import { auth } from '@/auth';

type AuthGuardProps = {
  children: React.ReactNode;
  /** Where to redirect if the auth check fails */
  redirectTo?: string;
  /** If true, requires the user to be authenticated; if false, requires NOT authenticated */
  requireAuth?: boolean;
};

/**
 * Server component that guards routes based on the NextAuth session.
 */
export async function AuthGuard({
  children,
  redirectTo = '/',
  requireAuth = true,
}: AuthGuardProps) {
  const session = await auth();
  const user = session?.user ?? null;

  if (requireAuth && !user) {
    redirect(redirectTo);
  }
  if (!requireAuth && user) {
    redirect(redirectTo);
  }

  return <>{children}</>;
}
