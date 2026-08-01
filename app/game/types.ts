export const GAME_MODE_IDS = ["expedition", "survival", "classic"] as const;
export type GameModeId = (typeof GAME_MODE_IDS)[number];

export const DIFFICULTY_IDS = ["cadet", "pilot", "ace"] as const;
export type DifficultyId = (typeof DIFFICULTY_IDS)[number];

export const SECTOR_IDS = [
  "starfield",
  "nebula",
  "meteor-belt",
  "ice",
  "ion-storm",
  "ship-graveyard",
  "solar",
  "dark",
  "boss",
] as const;
export type SectorId = (typeof SECTOR_IDS)[number];

export const ENEMY_ARCHETYPE_IDS = [
  "swift-asteroid",
  "splitter-asteroid",
  "armored-asteroid",
  "comet",
  "mine",
  "debris",
  "scout-drone",
  "gunner-drone",
  "hunter-drone",
  "support-drone",
] as const;
export type EnemyArchetypeId = (typeof ENEMY_ARCHETYPE_IDS)[number];

export const BOSS_IDS = [
  "sentinel-array",
  "comet-leviathan",
  "void-dreadnought",
] as const;
export type BossId = (typeof BOSS_IDS)[number];

export const UPGRADE_IDS = [
  "twin-shot",
  "rapid-fire",
  "piercing-rounds",
  "critical-focus",
  "reinforced-shield",
  "phase-plating",
  "repair-nanites",
  "engine-boost",
  "missile-bay",
  "emp-capacitor",
  "magnet-array",
  "escort-drone",
] as const;
export type UpgradeId = (typeof UPGRADE_IDS)[number];

export const POWER_UP_IDS = [
  "shield",
  "spread",
  "laser",
  "missiles",
  "emp",
  "time",
  "magnet",
  "drone",
  "repair",
  "pulse",
  "invulnerability",
  "critical",
  "speed",
  "charge",
] as const;
export type PowerUpId = (typeof POWER_UP_IDS)[number];

export type UpgradeCategory = "weapon" | "defense" | "utility";
export type PowerUpKind = "temporary" | "active" | "instant";
export type WavePhaseKind = "telegraph" | "combat" | "rest";

export type ModeBalance = {
  id: GameModeId;
  bossInterval: number | null;
  finiteWaveCount: number | null;
  allowsUpgradeChoices: boolean;
  sectorCycle: readonly SectorId[];
  telegraphDurationMs: number;
  combatDurationMs: number;
  restDurationMs: number;
  threatBase: number;
  threatGrowth: number;
};

export type DifficultyBalance = {
  id: DifficultyId;
  enemyHealthMultiplier: number;
  enemySpeedMultiplier: number;
  enemyDamageMultiplier: number;
  spawnBudgetMultiplier: number;
  scoreMultiplier: number;
  recoveryDropMultiplier: number;
};

export type SectorBalance = {
  id: SectorId;
  accent: string;
  backgroundTop: string;
  backgroundBottom: string;
  particleStyle:
    | "stars"
    | "mist"
    | "rocks"
    | "crystals"
    | "ions"
    | "wreckage"
    | "embers"
    | "shadows"
    | "arena";
  hazard:
    | "none"
    | "visibility-pulse"
    | "debris-lanes"
    | "cryo-drift"
    | "ion-pulse"
    | "minefield"
    | "solar-flare"
    | "limited-light"
    | "boss-arena";
  musicState: "calm" | "drive" | "danger" | "boss";
  preferredEnemies: readonly EnemyArchetypeId[];
};

export type EnemyBalance = {
  id: EnemyArchetypeId;
  unlockWave: number;
  threatCost: number;
  selectionWeight: number;
  baseHealth: number;
  baseSpeed: number;
  radius: number;
  score: number;
  telegraphMs: number;
  canBeElite: boolean;
};

export type BossBalance = {
  id: BossId;
  baseHealth: number;
  score: number;
  telegraphMs: number;
  phaseThresholds: readonly number[];
};

export type UpgradeBalance = {
  id: UpgradeId;
  category: UpgradeCategory;
  maxStacks: number;
  selectionWeight: number;
  compatibleModes: readonly GameModeId[];
};

export type PowerUpBalance = {
  id: PowerUpId;
  kind: PowerUpKind;
  durationMs: number;
  cooldownMs: number;
  energyCost: number;
};

export type UpgradeStacks = Partial<Record<UpgradeId, number>>;

export type WavePhase = {
  kind: WavePhaseKind;
  startsAtMs: number;
  durationMs: number;
};

export type EnemySpawn = {
  id: string;
  archetype: EnemyArchetypeId;
  spawnAtMs: number;
  telegraphAtMs: number;
  lane: number;
  elite: boolean;
  healthMultiplier: number;
  speedMultiplier: number;
};

export type BossSpawn = {
  id: string;
  boss: BossId;
  spawnAtMs: number;
  telegraphAtMs: number;
  healthMultiplier: number;
};

export type WavePlan = {
  wave: number;
  mode: GameModeId;
  difficulty: DifficultyId;
  sector: SectorId;
  seed: number;
  phases: readonly WavePhase[];
  spawns: readonly EnemySpawn[];
  boss: BossSpawn | null;
  threatBudget: number;
  totalDurationMs: number;
};

export type PowerUpRuntimeState = {
  id: PowerUpId;
  activatedAtMs: number;
  activeUntilMs: number;
  cooldownUntilMs: number;
};

export type RunController = "arduino" | "keyboard" | "touch" | "mixed";
export type RunControllerSource = Exclude<RunController, "mixed">;

export type RunSectorMetric = {
  wave: number;
  sectorId: SectorId;
  durationMs: number;
  completed: boolean;
  livesLost: number;
};

export type RunMetrics = {
  enemiesDestroyed: number;
  bossesDefeated: number;
  shotsFired: number;
  shotsHit: number;
  longestCombo: number;
  powerUpsCollected: number;
  powerUpsUsed: readonly PowerUpId[];
  powerUpsCollectedById: Partial<Record<PowerUpId, number>>;
  powerUpsActivatedById: Partial<Record<PowerUpId, number>>;
  flawlessSectors: number;
  livesLost: number;
  sectors: readonly RunSectorMetric[];
};
