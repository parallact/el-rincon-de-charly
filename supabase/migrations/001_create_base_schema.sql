-- Migration 001: base schema (RECONSTRUCTED)
--
-- ⚠️ The original 001 was never committed (applied out-of-band in the Supabase
-- SQL editor). The live project has since been paused >90 days and can no longer
-- be restored, so the exact original DDL/RLS is unrecoverable. This file is a
-- best-effort reconstruction from src/types/supabase.types.ts and the app's query
-- patterns, so the backend can be stood up from scratch on a fresh project.
-- REVIEW the RLS policies before relying on them.
--
-- It intentionally creates only the columns that existed before migrations
-- 005/007 added their own (rematch_requested_by, is_private) so those ALTERs
-- still apply cleanly on top.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================
-- profiles (public identity, 1:1 with auth.users)
-- ============================================
CREATE TABLE IF NOT EXISTS profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username   TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Usernames/avatars are shown to opponents and on the leaderboard: readable by any
-- authenticated user, writable only by the owner.
CREATE POLICY "Profiles are readable by authenticated users"
  ON profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can insert their own profile"
  ON profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "Users can update their own profile"
  ON profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Create a profile row automatically on signup.
CREATE OR REPLACE FUNCTION create_profile_for_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, username)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email, '@', 1)))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Error creating profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created_profile ON auth.users;
CREATE TRIGGER on_auth_user_created_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION create_profile_for_new_user();

-- ============================================
-- game_stats (per-user, per-game aggregates + leaderboard source)
-- ============================================
CREATE TABLE IF NOT EXISTS game_stats (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  game_type        TEXT NOT NULL,
  games_played     INTEGER NOT NULL DEFAULT 0,
  games_won        INTEGER NOT NULL DEFAULT 0,
  games_lost       INTEGER NOT NULL DEFAULT 0,
  games_draw       INTEGER NOT NULL DEFAULT 0,
  win_streak       INTEGER NOT NULL DEFAULT 0,
  best_win_streak  INTEGER NOT NULL DEFAULT 0,
  total_play_time  INTEGER NOT NULL DEFAULT 0,
  by_opponent      JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, game_type)
);

ALTER TABLE game_stats ENABLE ROW LEVEL SECURITY;

-- Stats feed a global leaderboard: readable by any authenticated user; each user
-- writes only their own rows.
CREATE POLICY "Stats are readable by authenticated users"
  ON game_stats FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can insert their own stats"
  ON game_stats FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own stats"
  ON game_stats FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_game_stats_user_id ON game_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_game_stats_game_type ON game_stats(game_type);

-- ============================================
-- game_rooms (online multiplayer sessions)
-- NOTE: is_private (007) and rematch_requested_by (005) are added by later
-- migrations, so they are intentionally omitted here.
-- ============================================
CREATE TABLE IF NOT EXISTS game_rooms (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_type       TEXT NOT NULL DEFAULT 'tic-tac-toe',
  status          TEXT NOT NULL DEFAULT 'waiting',   -- waiting | playing | finished
  player1_id      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  player2_id      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  current_turn    UUID,
  board           JSONB NOT NULL DEFAULT '["","","","","","","","",""]'::jsonb,
  winner_id       UUID,
  is_draw         BOOLEAN NOT NULL DEFAULT false,
  rematch_room_id UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE game_rooms ENABLE ROW LEVEL SECURITY;

-- Rooms are semi-public: matchmaking and invite links need to discover waiting
-- rooms, and both participants need to read their room. Kept broad for authed users.
CREATE POLICY "Rooms are readable by authenticated users"
  ON game_rooms FOR SELECT TO authenticated USING (true);

-- A player may create a room only as player1 (themselves).
CREATE POLICY "Users can create rooms as player1"
  ON game_rooms FOR INSERT TO authenticated WITH CHECK (auth.uid() = player1_id);

-- Participants may update their own room (joins, moves, end-game).
-- NOTE: this is deliberately broad and is why moves/results are client-authoritative;
-- see 011 and README for the hardening direction.
CREATE POLICY "Participants can update their room"
  ON game_rooms FOR UPDATE TO authenticated
  USING (auth.uid() = player1_id OR auth.uid() = player2_id OR player2_id IS NULL)
  WITH CHECK (auth.uid() = player1_id OR auth.uid() = player2_id);

-- The creator may delete a room that is still waiting (cancel).
CREATE POLICY "Creator can delete a waiting room"
  ON game_rooms FOR DELETE TO authenticated
  USING (auth.uid() = player1_id AND status = 'waiting');

CREATE INDEX IF NOT EXISTS idx_game_rooms_status ON game_rooms(status);
CREATE INDEX IF NOT EXISTS idx_game_rooms_game_type ON game_rooms(game_type);

-- Realtime: the app subscribes to per-room postgres_changes.
ALTER PUBLICATION supabase_realtime ADD TABLE game_rooms;
