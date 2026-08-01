import {
  BOSS_BALANCE,
  DIFFICULTY_BALANCE,
  ENEMY_BALANCE,
  MAX_PLANNABLE_WAVES,
  MODE_BALANCE,
  SECTOR_BALANCE,
} from "./balance.ts";
import { combineSeed, createSeededRng, hashSeed, type SeedInput } from "./rng.ts";
import type {
  BossId,
  BossSpawn,
  DifficultyId,
  EnemyArchetypeId,
  EnemySpawn,
  GameModeId,
  SectorId,
  WavePhase,
  WavePlan,
} from "./types.ts";

const BOSS_ORDER: readonly BossId[] = [
  "sentinel-array",
  "comet-leviathan",
  "void-dreadnought",
];

const CLASSIC_THREATS: readonly EnemyArchetypeId[] = [
  "swift-asteroid",
  "splitter-asteroid",
  "armored-asteroid",
  "comet",
  "debris",
];

export type CreateWavePlanOptions = {
  mode: GameModeId;
  difficulty: DifficultyId;
  wave: number;
  seed: SeedInput;
};

function assertWave(mode: GameModeId, wave: number) {
  if (!Number.isSafeInteger(wave) || wave < 1 || wave > MAX_PLANNABLE_WAVES) {
    throw new RangeError(
      `Wave must be between 1 and ${MAX_PLANNABLE_WAVES}.`,
    );
  }
  const finiteWaveCount = MODE_BALANCE[mode].finiteWaveCount;
  if (finiteWaveCount !== null && wave > finiteWaveCount) {
    throw new RangeError(`${mode} ends after wave ${finiteWaveCount}.`);
  }
}

export function getSectorIdForWave(mode: GameModeId, wave: number): SectorId {
  assertWave(mode, wave);
  const cycle = MODE_BALANCE[mode].sectorCycle;
  return cycle[(wave - 1) % cycle.length] as SectorId;
}

export function isBossWave(mode: GameModeId, wave: number) {
  assertWave(mode, wave);
  const interval = MODE_BALANCE[mode].bossInterval;
  return interval !== null && wave % interval === 0;
}

export function getBossIdForWave(
  mode: GameModeId,
  wave: number,
): BossId | null {
  if (!isBossWave(mode, wave)) return null;
  const interval = MODE_BALANCE[mode].bossInterval as number;
  const bossIndex = Math.floor(wave / interval) - 1;
  return BOSS_ORDER[bossIndex % BOSS_ORDER.length] as BossId;
}

export function isFinalModeWave(mode: GameModeId, wave: number) {
  assertWave(mode, wave);
  return MODE_BALANCE[mode].finiteWaveCount === wave;
}

function createPhases(
  mode: GameModeId,
  bossWave: boolean,
): readonly WavePhase[] {
  const config = MODE_BALANCE[mode];
  const restDurationMs = config.restDurationMs + (bossWave ? 2_000 : 0);
  return [
    {
      kind: "telegraph",
      startsAtMs: 0,
      durationMs: config.telegraphDurationMs,
    },
    {
      kind: "combat",
      startsAtMs: config.telegraphDurationMs,
      durationMs: config.combatDurationMs,
    },
    {
      kind: "rest",
      startsAtMs: config.telegraphDurationMs + config.combatDurationMs,
      durationMs: restDurationMs,
    },
  ];
}

function eligibleEnemies(
  mode: GameModeId,
  wave: number,
  remainingBudget: number,
) {
  return (Object.keys(ENEMY_BALANCE) as EnemyArchetypeId[]).filter((id) => {
    const enemy = ENEMY_BALANCE[id];
    return (
      (mode !== "classic" || CLASSIC_THREATS.includes(id)) &&
      enemy.unlockWave <= wave &&
      enemy.threatCost <= remainingBudget
    );
  });
}

function createEnemySpawns(
  mode: GameModeId,
  difficulty: DifficultyId,
  wave: number,
  sector: SectorId,
  seed: number,
  combatStartsAtMs: number,
  combatDurationMs: number,
  threatBudget: number,
  bossWave: boolean,
): EnemySpawn[] {
  const rng = createSeededRng(combineSeed(seed, "enemy-spawns"));
  const difficultyConfig = DIFFICULTY_BALANCE[difficulty];
  const preferred = new Set(SECTOR_BALANCE[sector].preferredEnemies);
  const spawns: EnemySpawn[] = [];
  let remainingBudget = bossWave
    ? Math.max(2, Math.floor(threatBudget * 0.42))
    : threatBudget;

  while (remainingBudget > 0 && spawns.length < 48) {
    const candidates = eligibleEnemies(mode, wave, remainingBudget);
    if (candidates.length === 0) break;
    const archetype = rng.weightedPick(candidates, (id) => {
      const enemy = ENEMY_BALANCE[id];
      return enemy.selectionWeight * (preferred.has(id) ? 1.9 : 1);
    });
    const enemy = ENEMY_BALANCE[archetype];
    remainingBudget -= enemy.threatCost;

    const eliteChance =
      enemy.canBeElite && wave >= 5
        ? Math.min(0.22, 0.025 * (wave - 4))
        : 0;
    const elite = rng.chance(eliteChance);
    const safeCombatWindow = Math.max(1, combatDurationMs - 900);
    const spawnAtMs =
      combatStartsAtMs + 450 + Math.floor(rng.next() * safeCombatWindow);
    spawns.push({
      id: `wave-${wave}-enemy-${spawns.length + 1}`,
      archetype,
      spawnAtMs,
      telegraphAtMs: Math.max(0, spawnAtMs - enemy.telegraphMs),
      lane: rng.integer(0, 6),
      elite,
      healthMultiplier:
        difficultyConfig.enemyHealthMultiplier * (elite ? 1.75 : 1),
      speedMultiplier:
        difficultyConfig.enemySpeedMultiplier * (elite ? 1.12 : 1),
    });
  }

  return spawns.sort(
    (left, right) => left.spawnAtMs - right.spawnAtMs || left.id.localeCompare(right.id),
  );
}

function createBossSpawn(
  mode: GameModeId,
  difficulty: DifficultyId,
  wave: number,
  combatStartsAtMs: number,
): BossSpawn | null {
  const boss = getBossIdForWave(mode, wave);
  if (!boss) return null;
  const config = BOSS_BALANCE[boss];
  const spawnAtMs = combatStartsAtMs + 500;
  return {
    id: `wave-${wave}-boss-${boss}`,
    boss,
    spawnAtMs,
    telegraphAtMs: Math.max(0, spawnAtMs - config.telegraphMs),
    healthMultiplier:
      DIFFICULTY_BALANCE[difficulty].enemyHealthMultiplier *
      (1 + Math.max(0, wave - 3) * 0.055),
  };
}

export function createWavePlan({
  mode,
  difficulty,
  wave,
  seed,
}: CreateWavePlanOptions): WavePlan {
  assertWave(mode, wave);
  const modeConfig = MODE_BALANCE[mode];
  const bossWave = isBossWave(mode, wave);
  const sector = getSectorIdForWave(mode, wave);
  const phases = createPhases(mode, bossWave);
  const combat = phases[1] as WavePhase;
  const waveSeed = combineSeed(seed, mode, difficulty, wave, sector);
  const threatBudget = Math.max(
    1,
    Math.round(
      (modeConfig.threatBase + modeConfig.threatGrowth * (wave - 1)) *
        DIFFICULTY_BALANCE[difficulty].spawnBudgetMultiplier,
    ),
  );
  const spawns = createEnemySpawns(
    mode,
    difficulty,
    wave,
    sector,
    waveSeed,
    combat.startsAtMs,
    combat.durationMs,
    threatBudget,
    bossWave,
  );
  const totalDurationMs = phases.reduce(
    (maximum, phase) =>
      Math.max(maximum, phase.startsAtMs + phase.durationMs),
    0,
  );

  return {
    wave,
    mode,
    difficulty,
    sector,
    seed: hashSeed(waveSeed),
    phases,
    spawns,
    boss: createBossSpawn(mode, difficulty, wave, combat.startsAtMs),
    threatBudget,
    totalDurationMs,
  };
}
