-- Make the Supabase Auth account the only identity: retire the access code.
--
-- After this migration a profile is reached exclusively through
-- game_account_links.auth_user_id. access_code_hash is kept as a NULLABLE column
-- rather than dropped, for three reasons:
--   * dropping it is irreversible and would break a code rollback to the 0004 API;
--   * the surviving rows still carry their historical digest, which is a useless
--     credential once the API stops accepting codes but is harmless evidence;
--   * Postgres UNIQUE permits many NULLs, so new account-only profiles simply
--     leave it empty without any constraint gymnastics.
--
-- No data is deleted here. Apply BEFORE deploying the account-only API: that API
-- inserts profiles without an access_code_hash and would fail the old NOT NULL.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

SELECT pg_advisory_xact_lock(7182736401948572::BIGINT);

-- 1. Account-only profiles have no code. The UNIQUE index stays and keeps
--    protecting the historical digests; NULLs are exempt from it by definition.
ALTER TABLE game_players
  ALTER COLUMN access_code_hash DROP NOT NULL;

-- 2. A profile must be reachable. Without a code, the only route is an account
--    link, so guard the invariant that a codeless profile is never orphaned.
--    NOT VALID first: existing rows all still have their digest, and validating
--    separately keeps the lock short on larger tables.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'game_players_reachable_check'
      AND conrelid = 'game_players'::regclass
  ) THEN
    ALTER TABLE game_players
      ADD CONSTRAINT game_players_reachable_check
      CHECK (
        access_code_hash IS NOT NULL
        OR profile_schema_version >= 3
      ) NOT VALID;
    ALTER TABLE game_players
      VALIDATE CONSTRAINT game_players_reachable_check;
  END IF;
END $$;

-- 3. profile_schema_version 3 marks an account-only profile. Widen the 0002
--    range check accordingly.
ALTER TABLE game_players
  DROP CONSTRAINT IF EXISTS game_players_profile_schema_version_check;
ALTER TABLE game_players
  ADD CONSTRAINT game_players_profile_schema_version_check
  CHECK (profile_schema_version BETWEEN 1 AND 3);

-- 4. Rate-limit scopes move from the access-code digest to the auth user id, so
--    the existing buckets are reused with new scope values and no bucket name
--    changes are needed. Purge the old counters: their HMAC scopes can never be
--    recomputed once codes stop being sent, so they would linger until the
--    two-day sweep while blocking nothing.
DELETE FROM game_rate_limits
  WHERE bucket IN ('profile_record', 'profile_rename');

COMMIT;
