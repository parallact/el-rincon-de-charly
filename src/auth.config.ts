import type { NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';

// Edge-safe config (no Prisma / bcrypt). The real credentials `authorize`
// implementation lives in auth.ts (Node runtime).
export const authConfig = {
  pages: {
    signIn: '/',
  },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      authorize: () => null, // placeholder; overridden in auth.ts
    }),
  ],
  callbacks: {
    // Route protection is handled per server action; the middleware only keeps
    // the session cookie fresh, so navigation is always allowed.
    authorized() {
      return true;
    },
  },
} satisfies NextAuthConfig;
