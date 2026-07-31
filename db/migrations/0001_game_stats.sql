-- Safe to run repeatedly in the Supabase SQL Editor. The Vercel function
-- applies the same additive schema automatically, but running this migration
-- first makes setup failures visible before the production deploy.
BEGIN;

SELECT pg_advisory_xact_lock(7182736401948572::BIGINT);

CREATE TABLE IF NOT EXISTS game_players (
  id BIGSERIAL PRIMARY KEY,
  access_code_hash CHAR(64) NOT NULL UNIQUE,
  nickname VARCHAR(20) NOT NULL,
  language VARCHAR(2) NOT NULL DEFAULT 'en',
  games_played BIGINT NOT NULL DEFAULT 0 CHECK (games_played >= 0),
  total_score BIGINT NOT NULL DEFAULT 0 CHECK (total_score >= 0),
  high_score BIGINT NOT NULL DEFAULT 0
    CHECK (high_score >= 0 AND high_score <= 100000000),
  highest_level INTEGER NOT NULL DEFAULT 0
    CHECK (highest_level >= 0 AND highest_level <= 9),
  total_duration_ms BIGINT NOT NULL DEFAULT 0 CHECK (total_duration_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (language IN ('uk', 'de', 'en'))
);

CREATE UNIQUE INDEX IF NOT EXISTS game_players_nickname_unique
  ON game_players (LOWER(nickname));

CREATE INDEX IF NOT EXISTS game_players_leaderboard_idx
  ON game_players (high_score DESC, total_score DESC, highest_level DESC);

CREATE TABLE IF NOT EXISTS game_runs (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES game_players(id) ON DELETE CASCADE,
  run_id VARCHAR(64) NOT NULL,
  score BIGINT NOT NULL CHECK (score >= 0 AND score <= 100000000),
  level INTEGER NOT NULL CHECK (level >= 1 AND level <= 9),
  duration_ms BIGINT NOT NULL CHECK (duration_ms >= 0 AND duration_ms <= 21600000),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (MOD(score, 10) = 0),
  CHECK (level <= LEAST(9, 1 + duration_ms / 22000)),
  UNIQUE (player_id, run_id)
);

CREATE INDEX IF NOT EXISTS game_runs_retention_idx
  ON game_runs (player_id, recorded_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS game_rate_limits (
  scope_hash CHAR(64) NOT NULL,
  bucket VARCHAR(24) NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count > 0),
  PRIMARY KEY (scope_hash, bucket),
  CHECK (
    bucket IN (
      'ip_create',
      'ip_write',
      'profile_record',
      'profile_rename'
    )
  )
);

CREATE INDEX IF NOT EXISTS game_rate_limits_cleanup_idx
  ON game_rate_limits (window_started_at);

-- Supabase exposes tables in the public schema through its Data API. No RLS
-- policies are created: anon/authenticated clients must use /api/stats instead.
ALTER TABLE game_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_rate_limits ENABLE ROW LEVEL SECURITY;

DELETE FROM game_rate_limits
  WHERE window_started_at < NOW() - INTERVAL '2 days';

COMMIT;
