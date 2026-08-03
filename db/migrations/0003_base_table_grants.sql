-- Align the base statistics tables with the deny-by-default grants that
-- 0002_game_progression.sql already applies to the v2 tables. Supabase Data API
-- grants and RLS are separate controls; 0001 enabled RLS but never revoked the
-- Data API roles, so those three tables relied on a single layer.
--
-- This migration changes privileges only. It creates nothing, drops nothing, and
-- touches no user rows, so it is safe to run repeatedly. Apply it before or after
-- 0002; it does not depend on the v2 objects. The Vercel function connects as the
-- table owner and is unaffected.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

SELECT pg_advisory_xact_lock(7182736401948572::BIGINT);

REVOKE ALL ON TABLE
  game_players,
  game_runs,
  game_rate_limits
FROM anon, authenticated, service_role;

REVOKE ALL ON SEQUENCE
  game_players_id_seq,
  game_runs_id_seq
FROM anon, authenticated, service_role;

COMMIT;
