-- Additive Space Defender progression schema. Apply this migration before the
-- matching API deployment. Runtime requests never execute DDL.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

SELECT pg_advisory_xact_lock(7182736401948572::BIGINT);

ALTER TABLE game_players
  ADD COLUMN IF NOT EXISTS stats_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS profile_schema_version SMALLINT NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'game_players_stats_revision_check'
      AND conrelid = 'game_players'::regclass
  ) THEN
    ALTER TABLE game_players
      ADD CONSTRAINT game_players_stats_revision_check
      CHECK (stats_revision >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'game_players_profile_schema_version_check'
      AND conrelid = 'game_players'::regclass
  ) THEN
    ALTER TABLE game_players
      ADD CONSTRAINT game_players_profile_schema_version_check
      CHECK (profile_schema_version BETWEEN 1 AND 2);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS game_sync_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES game_players(id) ON DELETE CASCADE,
  event_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  event_version SMALLINT NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (player_id, event_id),
  CHECK (event_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  CHECK (event_type IN ('run.completed', 'settings.updated')),
  CHECK (event_version > 0),
  CHECK (payload_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS game_sync_events_player_received_idx
  ON game_sync_events (player_id, received_at DESC, id DESC);

ALTER TABLE game_runs
  ADD COLUMN IF NOT EXISTS sync_event_id BIGINT REFERENCES game_sync_events(id),
  ADD COLUMN IF NOT EXISTS run_version SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS mode_id VARCHAR(24) NOT NULL DEFAULT 'classic',
  ADD COLUMN IF NOT EXISTS difficulty_id VARCHAR(16) NOT NULL DEFAULT 'pilot',
  ADD COLUMN IF NOT EXISTS highest_wave INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS final_sector_id VARCHAR(24) NOT NULL DEFAULT 'starfield',
  ADD COLUMN IF NOT EXISTS enemies_destroyed BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bosses_defeated BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shots_fired BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shots_hit BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS longest_combo BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS powerups_collected BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lives_lost INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS won BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS input_kind VARCHAR(16) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS ended_reason VARCHAR(32) NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS client_ended_at TIMESTAMPTZ;

ALTER TABLE game_runs
  DROP CONSTRAINT IF EXISTS game_runs_progression_check;
ALTER TABLE game_runs
  ADD CONSTRAINT game_runs_progression_check CHECK (
    run_version BETWEEN 1 AND 2
    AND mode_id IN ('expedition', 'survival', 'classic')
    AND difficulty_id IN ('cadet', 'pilot', 'ace')
    AND highest_wave BETWEEN 1 AND LEAST(
      CASE WHEN mode_id = 'expedition' THEN 9 ELSE 10000 END,
      1 + duration_ms / 22000
    )
    AND final_sector_id = CASE
      WHEN mode_id = 'classic' THEN 'starfield'
      WHEN MOD(highest_wave - 1, 9) = 0 THEN 'starfield'
      WHEN MOD(highest_wave - 1, 9) = 1 THEN 'nebula'
      WHEN MOD(highest_wave - 1, 9) = 2 THEN 'meteor-belt'
      WHEN MOD(highest_wave - 1, 9) = 3 THEN 'ice'
      WHEN MOD(highest_wave - 1, 9) = 4 THEN 'ion-storm'
      WHEN MOD(highest_wave - 1, 9) = 5 THEN 'ship-graveyard'
      WHEN MOD(highest_wave - 1, 9) = 6 THEN 'solar'
      WHEN MOD(highest_wave - 1, 9) = 7 THEN 'dark'
      ELSE 'boss'
    END
    AND enemies_destroyed BETWEEN 0 AND duration_ms / 100
    AND bosses_defeated BETWEEN 0 AND CASE
      WHEN mode_id = 'classic' THEN 0
      ELSE highest_wave / 3
    END
    AND shots_fired BETWEEN 0 AND 1000000000
    AND shots_hit BETWEEN 0 AND shots_fired
    AND longest_combo BETWEEN 0 AND enemies_destroyed
    AND powerups_collected BETWEEN 0 AND enemies_destroyed + bosses_defeated
    AND lives_lost BETWEEN 0 AND
      3 + powerups_collected + highest_wave + duration_ms / 30000
    AND input_kind IN ('unknown', 'keyboard', 'touch', 'arduino', 'mixed')
    AND ended_reason ~ '^[a-z][a-z0-9_-]{0,31}$'
    AND (
      (won AND mode_id = 'expedition' AND highest_wave = 9
        AND ended_reason = 'victory')
      OR (NOT won AND ended_reason <> 'victory')
    )
  ) NOT VALID;
ALTER TABLE game_runs
  VALIDATE CONSTRAINT game_runs_progression_check;

CREATE UNIQUE INDEX IF NOT EXISTS game_runs_sync_event_unique
  ON game_runs (sync_event_id)
  WHERE sync_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS game_run_power_stats (
  run_id BIGINT NOT NULL REFERENCES game_runs(id) ON DELETE CASCADE,
  power_id VARCHAR(24) NOT NULL,
  collected_count INTEGER NOT NULL DEFAULT 0,
  activated_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, power_id),
  CHECK (power_id IN (
    'shield', 'spread', 'laser', 'missiles', 'emp', 'time', 'magnet',
    'drone', 'repair', 'pulse', 'invulnerability', 'critical', 'speed',
    'charge'
  )),
  CHECK (collected_count BETWEEN 0 AND 1000000),
  CHECK (activated_count BETWEEN 0 AND 1000000)
);

CREATE TABLE IF NOT EXISTS game_run_sector_stats (
  run_id BIGINT NOT NULL REFERENCES game_runs(id) ON DELETE CASCADE,
  sector_index SMALLINT NOT NULL,
  sector_id VARCHAR(24) NOT NULL,
  completed BOOLEAN NOT NULL,
  lives_lost INTEGER NOT NULL DEFAULT 0,
  duration_ms BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, sector_index),
  CHECK (sector_index BETWEEN 0 AND 63),
  CHECK (sector_id IN (
    'starfield', 'nebula', 'meteor-belt', 'ice', 'ion-storm',
    'ship-graveyard', 'solar', 'dark', 'boss'
  )),
  CHECK (lives_lost BETWEEN 0 AND 1000000),
  CHECK (duration_ms BETWEEN 0 AND 21600000)
);

CREATE TABLE IF NOT EXISTS game_player_totals (
  player_id BIGINT PRIMARY KEY REFERENCES game_players(id) ON DELETE CASCADE,
  enemies_destroyed BIGINT NOT NULL DEFAULT 0,
  bosses_defeated BIGINT NOT NULL DEFAULT 0,
  shots_fired BIGINT NOT NULL DEFAULT 0,
  shots_hit BIGINT NOT NULL DEFAULT 0,
  longest_combo BIGINT NOT NULL DEFAULT 0,
  powerups_collected BIGINT NOT NULL DEFAULT 0,
  longest_run_ms BIGINT NOT NULL DEFAULT 0,
  wins BIGINT NOT NULL DEFAULT 0,
  arduino_runs BIGINT NOT NULL DEFAULT 0,
  best_accuracy_permille SMALLINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    enemies_destroyed >= 0 AND bosses_defeated >= 0
    AND shots_fired >= 0 AND shots_hit BETWEEN 0 AND shots_fired
    AND longest_combo >= 0 AND powerups_collected >= 0
    AND longest_run_ms BETWEEN 0 AND 21600000
    AND wins >= 0 AND arduino_runs >= 0
    AND best_accuracy_permille BETWEEN 0 AND 1000
  )
);

CREATE TABLE IF NOT EXISTS game_player_mode_stats (
  player_id BIGINT NOT NULL REFERENCES game_players(id) ON DELETE CASCADE,
  mode_id VARCHAR(24) NOT NULL,
  difficulty_id VARCHAR(16) NOT NULL,
  games_played BIGINT NOT NULL DEFAULT 0,
  total_score BIGINT NOT NULL DEFAULT 0,
  high_score BIGINT NOT NULL DEFAULT 0,
  highest_wave INTEGER NOT NULL DEFAULT 0,
  enemies_destroyed BIGINT NOT NULL DEFAULT 0,
  bosses_defeated BIGINT NOT NULL DEFAULT 0,
  total_duration_ms BIGINT NOT NULL DEFAULT 0,
  wins BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, mode_id, difficulty_id),
  CHECK (mode_id IN ('expedition', 'survival', 'classic')),
  CHECK (difficulty_id IN ('cadet', 'pilot', 'ace')),
  CHECK (
    games_played >= 0 AND total_score >= 0
    AND high_score BETWEEN 0 AND 100000000
    AND highest_wave BETWEEN 0 AND 10000
    AND enemies_destroyed >= 0 AND bosses_defeated >= 0
    AND total_duration_ms >= 0 AND wins >= 0
  )
);

CREATE INDEX IF NOT EXISTS game_player_mode_leaderboard_idx
  ON game_player_mode_stats (
    mode_id, difficulty_id, high_score DESC, total_score DESC, highest_wave DESC
  ) INCLUDE (player_id);

CREATE TABLE IF NOT EXISTS game_player_power_stats (
  player_id BIGINT NOT NULL REFERENCES game_players(id) ON DELETE CASCADE,
  power_id VARCHAR(24) NOT NULL,
  collected_count BIGINT NOT NULL DEFAULT 0,
  activated_count BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, power_id),
  CHECK (power_id IN (
    'shield', 'spread', 'laser', 'missiles', 'emp', 'time', 'magnet',
    'drone', 'repair', 'pulse', 'invulnerability', 'critical', 'speed',
    'charge'
  )),
  CHECK (collected_count >= 0 AND activated_count >= 0)
);

CREATE TABLE IF NOT EXISTS game_player_achievements (
  player_id BIGINT NOT NULL REFERENCES game_players(id) ON DELETE CASCADE,
  achievement_id VARCHAR(32) NOT NULL,
  progress_value BIGINT NOT NULL DEFAULT 0,
  unlocked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, achievement_id),
  CHECK (achievement_id IN (
    'first_run', 'first_enemy', 'first_boss', 'survivor_5m',
    'flawless_sector', 'combo_25', 'score_10000', 'sharpshooter', 'arduino_pilot',
    'power_explorer', 'max_level', 'veteran_10'
  )),
  CHECK (progress_value >= 0)
);

CREATE TABLE IF NOT EXISTS game_player_unlocks (
  player_id BIGINT NOT NULL REFERENCES game_players(id) ON DELETE CASCADE,
  unlock_id VARCHAR(64) NOT NULL,
  source_achievement_id VARCHAR(32),
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, unlock_id),
  CHECK (unlock_id ~ '^[a-z][a-z0-9:_-]{0,63}$')
);

CREATE TABLE IF NOT EXISTS game_player_settings (
  player_id BIGINT PRIMARY KEY REFERENCES game_players(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL DEFAULT 0,
  music_volume SMALLINT NOT NULL DEFAULT 70,
  effects_volume SMALLINT NOT NULL DEFAULT 80,
  screen_shake BOOLEAN NOT NULL DEFAULT TRUE,
  reduced_motion BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (revision >= 0),
  CHECK (music_volume BETWEEN 0 AND 100),
  CHECK (effects_volume BETWEEN 0 AND 100)
);

-- Preserve skill milestones already proven by the v1 lifetime aggregates.
-- Detailed enemy/power achievements cannot be reconstructed from v1 data and
-- therefore start at zero until a v2 run supplies those facts.
INSERT INTO game_player_achievements (
  player_id, achievement_id, progress_value, unlocked_at, updated_at
)
SELECT
  player.id,
  seed.achievement_id,
  seed.progress_value,
  CASE WHEN seed.progress_value >= seed.target THEN NOW() ELSE NULL END,
  NOW()
FROM game_players AS player
CROSS JOIN LATERAL (
  VALUES
    ('first_run'::VARCHAR(32), player.games_played, 1::BIGINT),
    ('score_10000'::VARCHAR(32), player.high_score::BIGINT, 10000::BIGINT),
    ('max_level'::VARCHAR(32), player.highest_level::BIGINT, 9::BIGINT),
    ('veteran_10'::VARCHAR(32), player.games_played, 10::BIGINT)
) AS seed(achievement_id, progress_value, target)
WHERE seed.progress_value > 0
ON CONFLICT (player_id, achievement_id) DO UPDATE SET
  progress_value = GREATEST(
    game_player_achievements.progress_value,
    EXCLUDED.progress_value
  ),
  unlocked_at = COALESCE(
    game_player_achievements.unlocked_at,
    EXCLUDED.unlocked_at
  ),
  updated_at = NOW();

INSERT INTO game_player_unlocks (
  player_id, unlock_id, source_achievement_id, unlocked_at
)
SELECT
  player_id,
  'achievement:' || achievement_id,
  achievement_id,
  unlocked_at
FROM game_player_achievements
WHERE unlocked_at IS NOT NULL
ON CONFLICT (player_id, unlock_id) DO NOTHING;

-- Extend the existing fixed-window bucket allowlist for weighted v2 syncs.
ALTER TABLE game_rate_limits
  DROP CONSTRAINT IF EXISTS game_rate_limits_bucket_check;
ALTER TABLE game_rate_limits
  ADD CONSTRAINT game_rate_limits_bucket_check CHECK (
    bucket IN (
      'ip_create', 'ip_write', 'profile_record', 'profile_rename',
      'profile_sync'
    )
  );

ALTER TABLE game_sync_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_run_power_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_run_sector_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_player_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_player_mode_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_player_power_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_player_achievements ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_player_unlocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_player_settings ENABLE ROW LEVEL SECURITY;

-- The browser must use /api/stats. Direct Data API roles receive no grants and
-- no RLS policies are created.
REVOKE ALL ON TABLE
  game_sync_events,
  game_run_power_stats,
  game_run_sector_stats,
  game_player_totals,
  game_player_mode_stats,
  game_player_power_stats,
  game_player_achievements,
  game_player_unlocks,
  game_player_settings
FROM anon, authenticated, service_role;

REVOKE ALL ON SEQUENCE game_sync_events_id_seq
FROM anon, authenticated, service_role;

COMMIT;
