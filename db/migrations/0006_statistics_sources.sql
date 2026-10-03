-- Apply after 0001–0005, before deploying source-aware clients/API.
-- Existing aggregates and ledger hashes are untouched. Historical provenance
-- cannot be inferred from input_kind: keyboard can accompany a connected UNO.
-- Every old run/aggregate is therefore explicitly legacy (unknown source).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(7182736401948572::BIGINT);

ALTER TABLE public.game_runs ADD COLUMN IF NOT EXISTS statistics_source TEXT NOT NULL DEFAULT 'legacy';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.game_runs'::regclass AND conname = 'game_runs_statistics_source_check') THEN
    ALTER TABLE public.game_runs ADD CONSTRAINT game_runs_statistics_source_check
      CHECK (statistics_source IN ('demo', 'arduino', 'legacy')) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.game_runs VALIDATE CONSTRAINT game_runs_statistics_source_check;
CREATE INDEX IF NOT EXISTS game_runs_player_source_idx ON public.game_runs (player_id, statistics_source);

SELECT set_config('game.source_backfill', (to_regclass('public.game_player_source_stats') IS NULL)::text, true);

CREATE TABLE IF NOT EXISTS public.game_player_source_stats (
  player_id BIGINT NOT NULL REFERENCES public.game_players(id) ON DELETE CASCADE,
  statistics_source TEXT NOT NULL CHECK (statistics_source IN ('demo', 'arduino', 'legacy')),
  games_played BIGINT NOT NULL DEFAULT 0 CHECK (games_played >= 0),
  total_score BIGINT NOT NULL DEFAULT 0 CHECK (total_score >= 0),
  high_score BIGINT NOT NULL DEFAULT 0 CHECK (high_score BETWEEN 0 AND 100000000),
  highest_level SMALLINT NOT NULL DEFAULT 0 CHECK (highest_level BETWEEN 0 AND 9),
  total_duration_ms BIGINT NOT NULL DEFAULT 0 CHECK (total_duration_ms >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, statistics_source)
);
CREATE INDEX IF NOT EXISTS game_source_leaderboard_idx ON public.game_player_source_stats
  (statistics_source, high_score DESC, total_score DESC, highest_level DESC, updated_at ASC)
  INCLUDE (player_id) WHERE games_played > 0;

INSERT INTO public.game_player_source_stats (player_id, statistics_source, games_played, total_score, high_score, highest_level, total_duration_ms, updated_at)
SELECT id, 'legacy', games_played, total_score, high_score, highest_level, total_duration_ms, updated_at
FROM public.game_players WHERE current_setting('game.source_backfill')::boolean ON CONFLICT (player_id, statistics_source) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.game_player_source_totals (
  statistics_source TEXT NOT NULL CHECK (statistics_source IN ('demo', 'arduino', 'legacy')),
  player_id BIGINT NOT NULL REFERENCES public.game_players(id) ON DELETE CASCADE,
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
  PRIMARY KEY (player_id, statistics_source),
  CHECK (
    enemies_destroyed >= 0 AND bosses_defeated >= 0
    AND shots_fired >= 0 AND shots_hit BETWEEN 0 AND shots_fired
    AND longest_combo >= 0 AND powerups_collected >= 0
    AND longest_run_ms BETWEEN 0 AND 21600000
    AND wins >= 0 AND arduino_runs >= 0
    AND best_accuracy_permille BETWEEN 0 AND 1000
  )
);
INSERT INTO public.game_player_source_totals (statistics_source, player_id, enemies_destroyed, bosses_defeated, shots_fired, shots_hit, longest_combo, powerups_collected, longest_run_ms, wins, arduino_runs, best_accuracy_permille, updated_at)
SELECT 'legacy', player_id, enemies_destroyed, bosses_defeated, shots_fired, shots_hit, longest_combo, powerups_collected, longest_run_ms, wins, arduino_runs, best_accuracy_permille, updated_at FROM public.game_player_totals WHERE current_setting('game.source_backfill')::boolean
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.game_player_source_mode_stats (
  statistics_source TEXT NOT NULL CHECK (statistics_source IN ('demo', 'arduino', 'legacy')),
  player_id BIGINT NOT NULL REFERENCES public.game_players(id) ON DELETE CASCADE,
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
  PRIMARY KEY (player_id, statistics_source, mode_id, difficulty_id),
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
INSERT INTO public.game_player_source_mode_stats (statistics_source, player_id, mode_id, difficulty_id, games_played, total_score, high_score, highest_wave, enemies_destroyed, bosses_defeated, total_duration_ms, wins, updated_at)
SELECT 'legacy', player_id, mode_id, difficulty_id, games_played, total_score, high_score, highest_wave, enemies_destroyed, bosses_defeated, total_duration_ms, wins, updated_at FROM public.game_player_mode_stats WHERE current_setting('game.source_backfill')::boolean
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.game_player_source_power_stats (
  statistics_source TEXT NOT NULL CHECK (statistics_source IN ('demo', 'arduino', 'legacy')),
  player_id BIGINT NOT NULL REFERENCES public.game_players(id) ON DELETE CASCADE,
  power_id VARCHAR(24) NOT NULL,
  collected_count BIGINT NOT NULL DEFAULT 0,
  activated_count BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, statistics_source, power_id),
  CHECK (power_id IN (
    'shield', 'spread', 'laser', 'missiles', 'emp', 'time', 'magnet',
    'drone', 'repair', 'pulse', 'invulnerability', 'critical', 'speed',
    'charge'
  )),
  CHECK (collected_count >= 0 AND activated_count >= 0)
);
INSERT INTO public.game_player_source_power_stats (statistics_source, player_id, power_id, collected_count, activated_count, updated_at)
SELECT 'legacy', player_id, power_id, collected_count, activated_count, updated_at FROM public.game_player_power_stats WHERE current_setting('game.source_backfill')::boolean
ON CONFLICT DO NOTHING;

-- Invoker triggers keep old clients/API versions correct during the deployment
-- window too. No authenticated/Data API role gets table or function privileges.
CREATE OR REPLACE FUNCTION public.game_accumulate_source_run() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.game_player_source_stats (player_id, statistics_source, games_played, total_score, high_score, highest_level, total_duration_ms)
  VALUES (NEW.player_id, NEW.statistics_source, 1, NEW.score, NEW.score, NEW.level, NEW.duration_ms)
  ON CONFLICT (player_id, statistics_source) DO UPDATE SET
    games_played = LEAST(game_player_source_stats.games_played + EXCLUDED.games_played, 9007199254740991),
    total_score = LEAST(game_player_source_stats.total_score + EXCLUDED.total_score, 9007199254740991),
    high_score = GREATEST(game_player_source_stats.high_score, EXCLUDED.high_score),
    highest_level = GREATEST(game_player_source_stats.highest_level, EXCLUDED.highest_level),
    total_duration_ms = LEAST(game_player_source_stats.total_duration_ms + EXCLUDED.total_duration_ms, 9007199254740991),
    updated_at = NOW();
  INSERT INTO public.game_player_source_totals (player_id, statistics_source, enemies_destroyed, bosses_defeated, shots_fired, shots_hit, longest_combo, powerups_collected, longest_run_ms, wins, arduino_runs, best_accuracy_permille)
  VALUES (NEW.player_id, NEW.statistics_source, NEW.enemies_destroyed, NEW.bosses_defeated, NEW.shots_fired, NEW.shots_hit, NEW.longest_combo, NEW.powerups_collected, NEW.duration_ms, CASE WHEN NEW.won THEN 1 ELSE 0 END, CASE WHEN NEW.input_kind IN ('arduino', 'mixed') THEN 1 ELSE 0 END, CASE WHEN NEW.shots_fired >= 10 THEN FLOOR(NEW.shots_hit::numeric * 1000 / NEW.shots_fired)::integer ELSE 0 END)
  ON CONFLICT (player_id, statistics_source) DO UPDATE SET
    enemies_destroyed = LEAST(game_player_source_totals.enemies_destroyed + EXCLUDED.enemies_destroyed, 9007199254740991),
    bosses_defeated = LEAST(game_player_source_totals.bosses_defeated + EXCLUDED.bosses_defeated, 9007199254740991),
    shots_fired = LEAST(game_player_source_totals.shots_fired + EXCLUDED.shots_fired, 9007199254740991),
    shots_hit = LEAST(game_player_source_totals.shots_hit + EXCLUDED.shots_hit, 9007199254740991),
    longest_combo = GREATEST(game_player_source_totals.longest_combo, EXCLUDED.longest_combo),
    powerups_collected = LEAST(game_player_source_totals.powerups_collected + EXCLUDED.powerups_collected, 9007199254740991),
    longest_run_ms = GREATEST(game_player_source_totals.longest_run_ms, EXCLUDED.longest_run_ms),
    wins = LEAST(game_player_source_totals.wins + EXCLUDED.wins, 9007199254740991),
    arduino_runs = LEAST(game_player_source_totals.arduino_runs + EXCLUDED.arduino_runs, 9007199254740991),
    best_accuracy_permille = GREATEST(game_player_source_totals.best_accuracy_permille, EXCLUDED.best_accuracy_permille),
    updated_at = NOW();
  INSERT INTO public.game_player_source_mode_stats (player_id, statistics_source, mode_id, difficulty_id, games_played, total_score, high_score, total_duration_ms, highest_wave, enemies_destroyed, bosses_defeated, wins)
  VALUES (NEW.player_id, NEW.statistics_source, NEW.mode_id, NEW.difficulty_id, 1, NEW.score, NEW.score, NEW.duration_ms, NEW.highest_wave, NEW.enemies_destroyed, NEW.bosses_defeated, CASE WHEN NEW.won THEN 1 ELSE 0 END)
  ON CONFLICT (player_id, statistics_source, mode_id, difficulty_id) DO UPDATE SET
    games_played = LEAST(game_player_source_mode_stats.games_played + EXCLUDED.games_played, 9007199254740991),
    total_score = LEAST(game_player_source_mode_stats.total_score + EXCLUDED.total_score, 9007199254740991),
    high_score = GREATEST(game_player_source_mode_stats.high_score, EXCLUDED.high_score),
    total_duration_ms = LEAST(game_player_source_mode_stats.total_duration_ms + EXCLUDED.total_duration_ms, 9007199254740991),
    highest_wave = GREATEST(game_player_source_mode_stats.highest_wave, EXCLUDED.highest_wave),
    enemies_destroyed = LEAST(game_player_source_mode_stats.enemies_destroyed + EXCLUDED.enemies_destroyed, 9007199254740991),
    bosses_defeated = LEAST(game_player_source_mode_stats.bosses_defeated + EXCLUDED.bosses_defeated, 9007199254740991),
    wins = LEAST(game_player_source_mode_stats.wins + EXCLUDED.wins, 9007199254740991),
    updated_at = NOW();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.game_accumulate_source_run() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS game_accumulate_source_run ON public.game_runs;
CREATE TRIGGER game_accumulate_source_run AFTER INSERT ON public.game_runs
  FOR EACH ROW EXECUTE FUNCTION public.game_accumulate_source_run();

CREATE OR REPLACE FUNCTION public.game_accumulate_source_power() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.game_player_source_power_stats
    (player_id, statistics_source, power_id, collected_count, activated_count)
  SELECT player_id, statistics_source, NEW.power_id, NEW.collected_count, NEW.activated_count
  FROM public.game_runs WHERE id = NEW.run_id
  ON CONFLICT (player_id, statistics_source, power_id) DO UPDATE SET
    collected_count = LEAST(game_player_source_power_stats.collected_count + EXCLUDED.collected_count, 9007199254740991),
    activated_count = LEAST(game_player_source_power_stats.activated_count + EXCLUDED.activated_count, 9007199254740991),
    updated_at = NOW();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.game_accumulate_source_power() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS game_accumulate_source_power ON public.game_run_power_stats;
CREATE TRIGGER game_accumulate_source_power AFTER INSERT ON public.game_run_power_stats
  FOR EACH ROW EXECUTE FUNCTION public.game_accumulate_source_power();

ALTER TABLE public.game_player_source_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.game_player_source_stats FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.game_player_source_totals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.game_player_source_totals FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.game_player_source_mode_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.game_player_source_mode_stats FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.game_player_source_power_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.game_player_source_power_stats FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
