// Auth types (NextAuth-backed). The session user is provided by next-auth.

export interface AuthUser {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
}

export interface Profile {
  id: string;
  username: string | null;
  avatar_url: string | null;
  games_played: number;
  games_won: number;
  win_rate: number;
  created_at?: string;
  updated_at?: string;
}
