import NextAuth from 'next-auth';
import { authConfig } from './auth.config';

// NextAuth middleware (Next.js 16 `proxy` convention). Keeps the session cookie
// fresh on navigation; per-action authorization is enforced in the server actions.
const { auth } = NextAuth(authConfig);

export const proxy = auth;

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
