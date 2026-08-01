import { MAX_RUN_DURATION_MS, MAX_THREAT_LEVEL } from "./balance.ts";
import type { PowerUpId, RunController, RunMetrics } from "./types.ts";

export const ACHIEVEMENT_IDS = [
  "first_run",
  "first_enemy",
  "first_boss",
  "survivor_5m",
  "flawless_sector",
  "combo_25",
  "score_10000",
  "arduino_pilot",
  "power_explorer",
  "max_level",
  "veteran_10",
  "sharpshooter",
] as const;
export type AchievementId = (typeof ACHIEVEMENT_IDS)[number];
export type AchievementRarity = "common" | "rare" | "epic" | "legendary";

export type AchievementMetric =
  | "gamesPlayed"
  | "enemiesDestroyed"
  | "bossesDefeated"
  | "longestRunMs"
  | "flawlessSectors"
  | "longestCombo"
  | "highScore"
  | "arduinoRuns"
  | "distinctPowerUpsUsed"
  | "maxThreatLevel"
  | "bestAccuracyPermille";

export type AchievementDefinition = {
  id: AchievementId;
  rarity: AchievementRarity;
  icon: string;
  metric: AchievementMetric;
  target: number;
};

export type AchievementProgress = {
  id: AchievementId;
  progress: number;
  target: number;
  unlockedAtMs: number | null;
};

export type LifetimeAchievementStats = {
  gamesPlayed: number;
  enemiesDestroyed: number;
  bossesDefeated: number;
  longestRunMs: number;
  flawlessSectors: number;
  longestCombo: number;
  highScore: number;
  arduinoRuns: number;
  powerUpsUsed: readonly PowerUpId[];
  maxThreatLevel: number;
  bestAccuracyPermille: number;
};

export type AchievementRunFacts = {
  durationMs: number;
  score: number;
  threatLevel: number;
  controller: RunController;
  metrics: RunMetrics;
};

export const EMPTY_ACHIEVEMENT_STATS: LifetimeAchievementStats = {
  gamesPlayed: 0,
  enemiesDestroyed: 0,
  bossesDefeated: 0,
  longestRunMs: 0,
  flawlessSectors: 0,
  longestCombo: 0,
  highScore: 0,
  arduinoRuns: 0,
  powerUpsUsed: [],
  maxThreatLevel: 0,
  bestAccuracyPermille: 0,
};

export const ACHIEVEMENTS = {
  first_run: {
    id: "first_run",
    rarity: "common",
    icon: "launch",
    metric: "gamesPlayed",
    target: 1,
  },
  first_enemy: {
    id: "first_enemy",
    rarity: "common",
    icon: "target",
    metric: "enemiesDestroyed",
    target: 1,
  },
  first_boss: {
    id: "first_boss",
    rarity: "rare",
    icon: "boss",
    metric: "bossesDefeated",
    target: 1,
  },
  survivor_5m: {
    id: "survivor_5m",
    rarity: "rare",
    icon: "timer",
    metric: "longestRunMs",
    target: 300_000,
  },
  flawless_sector: {
    id: "flawless_sector",
    rarity: "rare",
    icon: "shield",
    metric: "flawlessSectors",
    target: 1,
  },
  combo_25: {
    id: "combo_25",
    rarity: "rare",
    icon: "combo",
    metric: "longestCombo",
    target: 25,
  },
  score_10000: {
    id: "score_10000",
    rarity: "epic",
    icon: "star",
    metric: "highScore",
    target: 10_000,
  },
  arduino_pilot: {
    id: "arduino_pilot",
    rarity: "rare",
    icon: "controller",
    metric: "arduinoRuns",
    target: 1,
  },
  power_explorer: {
    id: "power_explorer",
    rarity: "legendary",
    icon: "power",
    metric: "distinctPowerUpsUsed",
    target: 14,
  },
  max_level: {
    id: "max_level",
    rarity: "epic",
    icon: "level",
    metric: "maxThreatLevel",
    target: MAX_THREAT_LEVEL,
  },
  veteran_10: {
    id: "veteran_10",
    rarity: "epic",
    icon: "medal",
    metric: "gamesPlayed",
    target: 10,
  },
  sharpshooter: {
    id: "sharpshooter",
    rarity: "rare",
    icon: "crosshair",
    metric: "bestAccuracyPermille",
    target: 700,
  },
} as const satisfies Record<AchievementId, AchievementDefinition>;

function metricValue(
  definition: AchievementDefinition,
  stats: LifetimeAchievementStats,
) {
  if (definition.metric === "distinctPowerUpsUsed") {
    return new Set(stats.powerUpsUsed).size;
  }
  return stats[definition.metric];
}

function safeCount(value: number, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

export function accumulateAchievementStats(
  current: LifetimeAchievementStats,
  run: AchievementRunFacts,
): LifetimeAchievementStats {
  return mergeAchievementStats(current, run, true);
}

export function previewAchievementStats(
  current: LifetimeAchievementStats,
  run: AchievementRunFacts,
): LifetimeAchievementStats {
  return mergeAchievementStats(current, run, false);
}

function mergeAchievementStats(
  current: LifetimeAchievementStats,
  run: AchievementRunFacts,
  completed: boolean,
): LifetimeAchievementStats {
  const shotsFired = safeCount(run.metrics.shotsFired);
  const shotsHit = Math.min(shotsFired, safeCount(run.metrics.shotsHit));
  const runAccuracyPermille =
    shotsFired >= 10 ? Math.floor((shotsHit / shotsFired) * 1_000) : 0;
  const usedPowerUps = new Set<PowerUpId>(current.powerUpsUsed);
  for (const powerUp of run.metrics.powerUpsUsed) usedPowerUps.add(powerUp);

  return {
    gamesPlayed: safeCount(current.gamesPlayed) + (completed ? 1 : 0),
    enemiesDestroyed:
      safeCount(current.enemiesDestroyed) +
      safeCount(run.metrics.enemiesDestroyed),
    bossesDefeated:
      safeCount(current.bossesDefeated) + safeCount(run.metrics.bossesDefeated),
    longestRunMs: Math.max(
      safeCount(current.longestRunMs, MAX_RUN_DURATION_MS),
      safeCount(run.durationMs, MAX_RUN_DURATION_MS),
    ),
    flawlessSectors:
      safeCount(current.flawlessSectors) + safeCount(run.metrics.flawlessSectors),
    longestCombo: Math.max(
      safeCount(current.longestCombo),
      safeCount(run.metrics.longestCombo),
    ),
    highScore: Math.max(safeCount(current.highScore), safeCount(run.score)),
    arduinoRuns:
      safeCount(current.arduinoRuns) +
      (completed && (run.controller === "arduino" || run.controller === "mixed")
        ? 1
        : 0),
    powerUpsUsed: [...usedPowerUps].sort(),
    maxThreatLevel: Math.max(
      safeCount(current.maxThreatLevel, MAX_THREAT_LEVEL),
      safeCount(run.threatLevel, MAX_THREAT_LEVEL),
    ),
    bestAccuracyPermille: Math.max(
      safeCount(current.bestAccuracyPermille, 1_000),
      runAccuracyPermille,
    ),
  };
}

export function evaluateAchievements(
  stats: LifetimeAchievementStats,
  previous: Partial<Record<AchievementId, AchievementProgress>> = {},
  nowMs: number,
) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError("Achievement timestamp must be a non-negative integer.");
  }
  const progress = {} as Record<AchievementId, AchievementProgress>;
  const newlyUnlocked: AchievementId[] = [];

  for (const id of ACHIEVEMENT_IDS) {
    const definition = ACHIEVEMENTS[id];
    const old = previous[id];
    const value = Math.min(
      definition.target,
      Math.max(safeCount(old?.progress ?? 0), safeCount(metricValue(definition, stats))),
    );
    const wasUnlocked = old?.unlockedAtMs !== null && old?.unlockedAtMs !== undefined;
    const isUnlocked = value >= definition.target;
    if (!wasUnlocked && isUnlocked) newlyUnlocked.push(id);
    progress[id] = {
      id,
      progress: value,
      target: definition.target,
      unlockedAtMs: wasUnlocked
        ? (old?.unlockedAtMs as number)
        : isUnlocked
          ? nowMs
          : null,
    };
  }

  return { progress, newlyUnlocked };
}
