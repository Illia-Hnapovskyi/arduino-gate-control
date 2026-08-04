-- Additive account-linking schema for Supabase Auth integration. Apply this
-- migration BEFORE deploying the matching API: the code that reads these
-- objects fails closed (503) while they are absent, but a bearer `link` call
-- against a database without this migration would surface as an
-- indistinguishable 503 DATABASE_UNAVAILABLE. Runtime requests never run DDL.
--
-- Design summary:
-- * game_players.public_id — stable opaque UUID, NOT a credential. Safe to
--   show in URLs/exports; used to deduplicate local profile entries.
-- * game_account_links — private 1:1 mapping between game_players and
--   auth.users. PRIMARY KEY (player_id) gives "one profile → max one
--   account"; UNIQUE (auth_user_id) gives "one account → max one profile".
--   ON DELETE CASCADE on both FKs: deleting the auth user removes only the
--   mapping row and keeps the profile, runs and progression.
-- * New fixed-window rate-limit buckets for linking and bearer mutations.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

SELECT pg_advisory_xact_lock(7182736401948572::BIGINT);

-- 1. Stable opaque public profile ID. Two-step add + backfill keeps the
--    pattern safe for large tables even though game_players is tiny today.
ALTER TABLE game_players
  ADD COLUMN IF NOT EXISTS public_id UUID;

UPDATE game_players
  SET public_id = gen_random_uuid()
  WHERE public_id IS NULL;

ALTER TABLE game_players
  ALTER COLUMN public_id SET DEFAULT gen_random_uuid();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'game_players_public_id_not_null'
      AND conrelid = 'game_players'::regclass
  ) THEN
    ALTER TABLE game_players
      ADD CONSTRAINT game_players_public_id_not_null
      CHECK (public_id IS NOT NULL) NOT VALID;
    ALTER TABLE game_players
      VALIDATE CONSTRAINT game_players_public_id_not_null;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS game_players_public_id_unique
  ON game_players (public_id);

-- 2. Private 1:1 account↔profile mapping.
CREATE TABLE IF NOT EXISTS game_account_links (
  player_id BIGINT PRIMARY KEY
    REFERENCES game_players(id) ON DELETE CASCADE,
  auth_user_id UUID NOT NULL UNIQUE
    REFERENCES auth.users(id) ON DELETE CASCADE,
  link_method VARCHAR(24) NOT NULL DEFAULT 'code',
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (link_method IN ('code', 'create'))
);

-- PRIMARY KEY covers player_id lookups; the UNIQUE constraint's index covers
-- auth_user_id lookups. Both FK columns are therefore indexed.

-- 3. Extend the fixed-window bucket allowlist for account operations.
ALTER TABLE game_rate_limits
  DROP CONSTRAINT IF EXISTS game_rate_limits_bucket_check;
ALTER TABLE game_rate_limits
  ADD CONSTRAINT game_rate_limits_bucket_check CHECK (
    bucket IN (
      'ip_create', 'ip_write', 'profile_record', 'profile_rename',
      'profile_sync',
      'ip_link', 'account_link'
    )
  );

-- 4. Deny-by-default: RLS with no policies plus explicit revokes, matching
--    0002/0003. The Vercel function connects as the table owner and is
--    unaffected. Never add FORCE ROW LEVEL SECURITY here: the owner relies on
--    the default owner bypass and there are deliberately no policies.
ALTER TABLE game_account_links ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE game_account_links
FROM anon, authenticated, service_role;

COMMIT;
