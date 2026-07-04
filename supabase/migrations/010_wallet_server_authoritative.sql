-- Migration 010: make the wallet / betting economy server-authoritative
--
-- Before this migration the wallet balance was fully client-controlled: the
-- "Users can update their own wallet" RLS policy allowed a client to set its own
-- `balance` to any value, and the client store credited its own winnings and
-- minted a 1000-credit "daily bonus" with no server-side limit. These are virtual
-- credits, but the integrity of betting and the leaderboard depended on the client
-- behaving.
--
-- This replaces that model: every balance mutation goes through a SECURITY DEFINER
-- function that validates the transition, and the direct client UPDATE/INSERT
-- policies are dropped. Bet settlement reads the authoritative game_rooms result
-- and pays out at most once per (room, player).

-- Idempotency ledger so a bet is paid out / refunded at most once per player.
CREATE TABLE IF NOT EXISTS bet_settlements (
  room_id    UUID NOT NULL,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
ALTER TABLE bet_settlements ENABLE ROW LEVEL SECURITY;
-- No policies: only the SECURITY DEFINER functions below touch this table.

-- Ensure a wallet exists for the current user (replaces the client-side INSERT).
CREATE OR REPLACE FUNCTION wallet_ensure()
RETURNS wallets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_wallet wallets;
BEGIN
  INSERT INTO wallets (user_id, balance) VALUES (auth.uid(), 1000.00)
    ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_wallet FROM wallets WHERE user_id = auth.uid();
  RETURN v_wallet;
END; $$;

-- Debit a bet from the caller's wallet (validates funds).
CREATE OR REPLACE FUNCTION wallet_place_bet(
  p_amount NUMERIC,
  p_game_slug TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL
)
RETURNS wallets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_wallet wallets; v_new NUMERIC;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid bet amount';
  END IF;
  SELECT * INTO v_wallet FROM wallets WHERE user_id = auth.uid() FOR UPDATE;
  IF v_wallet IS NULL THEN RAISE EXCEPTION 'Wallet not found'; END IF;
  IF v_wallet.balance < p_amount THEN RAISE EXCEPTION 'Insufficient balance'; END IF;

  v_new := v_wallet.balance - p_amount;
  UPDATE wallets SET balance = v_new, updated_at = now()
    WHERE id = v_wallet.id RETURNING * INTO v_wallet;
  INSERT INTO wallet_transactions (wallet_id, type, amount, balance_after, description, game_slug)
    VALUES (v_wallet.id, 'bet', -p_amount, v_new, COALESCE(p_description, 'Apuesta'), p_game_slug);
  RETURN v_wallet;
END; $$;

-- Settle a finished bet game FROM the authoritative room state (not a client
-- amount). Pays the pot to the winner, refunds a draw, nothing to the loser.
-- Idempotent per (room, caller): the winner cannot be paid twice.
CREATE OR REPLACE FUNCTION wallet_settle_bet(p_room_id UUID)
RETURNS wallets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_room game_rooms; v_wallet wallets; v_bet NUMERIC; v_payout NUMERIC := 0; v_uid UUID := auth.uid();
BEGIN
  SELECT * INTO v_room FROM game_rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN RAISE EXCEPTION 'Room not found'; END IF;
  IF v_room.status <> 'finished' THEN RAISE EXCEPTION 'Game not finished'; END IF;
  IF v_uid <> v_room.player1_id AND v_uid <> v_room.player2_id THEN
    RAISE EXCEPTION 'Not a participant';
  END IF;

  v_bet := COALESCE((v_room.metadata->>'bet_amount')::NUMERIC, 0);

  SELECT * INTO v_wallet FROM wallets WHERE user_id = v_uid FOR UPDATE;
  IF v_wallet IS NULL THEN RAISE EXCEPTION 'Wallet not found'; END IF;
  IF v_bet <= 0 THEN RETURN v_wallet; END IF;

  -- One payout per (room, player).
  INSERT INTO bet_settlements (room_id, user_id) VALUES (p_room_id, v_uid)
    ON CONFLICT (room_id, user_id) DO NOTHING;
  IF NOT FOUND THEN RETURN v_wallet; END IF; -- already settled/cancelled

  IF v_room.is_draw THEN
    v_payout := v_bet;            -- refund the stake
  ELSIF v_room.winner_id = v_uid THEN
    v_payout := v_bet * 2;        -- take the pot
  ELSE
    v_payout := 0;                -- loser keeps nothing
  END IF;

  IF v_payout > 0 THEN
    UPDATE wallets SET balance = balance + v_payout, updated_at = now()
      WHERE id = v_wallet.id RETURNING * INTO v_wallet;
    INSERT INTO wallet_transactions (wallet_id, type, amount, balance_after, description, game_slug)
      VALUES (v_wallet.id,
              CASE WHEN v_room.is_draw THEN 'refund' ELSE 'win' END,
              v_payout, v_wallet.balance,
              CASE WHEN v_room.is_draw THEN 'Reembolso por empate' ELSE 'Victoria en partida con apuesta' END,
              v_room.game_type);
  END IF;
  RETURN v_wallet;
END; $$;

-- Refund a placed bet when a still-unfinished room is abandoned. Shares the
-- bet_settlements key with settle so a stake is returned at most once.
CREATE OR REPLACE FUNCTION wallet_cancel_bet(p_room_id UUID)
RETURNS wallets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_room game_rooms; v_wallet wallets; v_bet NUMERIC; v_uid UUID := auth.uid();
BEGIN
  SELECT * INTO v_room FROM game_rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN RAISE EXCEPTION 'Room not found'; END IF;
  IF v_room.status = 'finished' THEN RAISE EXCEPTION 'Game already finished'; END IF;
  IF v_uid <> v_room.player1_id AND v_uid <> v_room.player2_id THEN
    RAISE EXCEPTION 'Not a participant';
  END IF;

  v_bet := COALESCE((v_room.metadata->>'bet_amount')::NUMERIC, 0);
  SELECT * INTO v_wallet FROM wallets WHERE user_id = v_uid FOR UPDATE;
  IF v_wallet IS NULL THEN RAISE EXCEPTION 'Wallet not found'; END IF;
  IF v_bet <= 0 THEN RETURN v_wallet; END IF;

  INSERT INTO bet_settlements (room_id, user_id) VALUES (p_room_id, v_uid)
    ON CONFLICT (room_id, user_id) DO NOTHING;
  IF NOT FOUND THEN RETURN v_wallet; END IF;

  UPDATE wallets SET balance = balance + v_bet, updated_at = now()
    WHERE id = v_wallet.id RETURNING * INTO v_wallet;
  INSERT INTO wallet_transactions (wallet_id, type, amount, balance_after, description, game_slug)
    VALUES (v_wallet.id, 'refund', v_bet, v_wallet.balance, 'Reembolso por cancelar', v_room.game_type);
  RETURN v_wallet;
END; $$;

-- Daily bonus, enforced server-side to once per 24h (was a free client faucet).
CREATE OR REPLACE FUNCTION wallet_claim_daily_bonus()
RETURNS wallets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_wallet wallets; v_last TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_wallet FROM wallets WHERE user_id = auth.uid() FOR UPDATE;
  IF v_wallet IS NULL THEN RAISE EXCEPTION 'Wallet not found'; END IF;

  SELECT max(created_at) INTO v_last FROM wallet_transactions
    WHERE wallet_id = v_wallet.id AND type = 'bonus';
  IF v_last IS NOT NULL AND v_last > now() - INTERVAL '24 hours' THEN
    RAISE EXCEPTION 'Daily bonus already claimed';
  END IF;

  UPDATE wallets SET balance = balance + 1000.00, updated_at = now()
    WHERE id = v_wallet.id RETURNING * INTO v_wallet;
  INSERT INTO wallet_transactions (wallet_id, type, amount, balance_after, description)
    VALUES (v_wallet.id, 'bonus', 1000.00, v_wallet.balance, 'Bonificacion diaria');
  RETURN v_wallet;
END; $$;

-- Credit a single-player win (currently only Plinko).
--
-- ⚠️ LIMITATION: Plinko resolves the multiplier with client-side physics, so the
-- win amount here is asserted by the client — this function does not verify it.
-- It exists so single-player wins still work once the blanket wallet UPDATE
-- policy is removed, and so the trusted surface is one narrow, named path instead
-- of "set balance to anything". Making Plinko provably fair (server-side RNG that
-- decides the landing buckets, with the client animating to them) is the remaining
-- hardening and is intentionally out of scope for this migration.
CREATE OR REPLACE FUNCTION wallet_credit(
  p_amount NUMERIC,
  p_game_slug TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL
)
RETURNS wallets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_wallet wallets;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid credit amount';
  END IF;
  SELECT * INTO v_wallet FROM wallets WHERE user_id = auth.uid() FOR UPDATE;
  IF v_wallet IS NULL THEN RAISE EXCEPTION 'Wallet not found'; END IF;

  UPDATE wallets SET balance = balance + p_amount, updated_at = now()
    WHERE id = v_wallet.id RETURNING * INTO v_wallet;
  INSERT INTO wallet_transactions (wallet_id, type, amount, balance_after, description, game_slug)
    VALUES (v_wallet.id, 'win', p_amount, v_wallet.balance, COALESCE(p_description, 'Ganancia'), p_game_slug);
  RETURN v_wallet;
END; $$;

-- Remove direct client mutation of balances and the ledger. Reads stay open;
-- all writes now flow through the functions above (which bypass RLS as definer).
DROP POLICY IF EXISTS "Users can update their own wallet" ON wallets;
DROP POLICY IF EXISTS "Users can create their own wallet" ON wallets;
DROP POLICY IF EXISTS "Users can create transactions for their wallet" ON wallet_transactions;

GRANT EXECUTE ON FUNCTION wallet_ensure() TO authenticated;
GRANT EXECUTE ON FUNCTION wallet_place_bet(NUMERIC, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION wallet_settle_bet(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION wallet_cancel_bet(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION wallet_claim_daily_bonus() TO authenticated;
GRANT EXECUTE ON FUNCTION wallet_credit(NUMERIC, TEXT, TEXT) TO authenticated;
