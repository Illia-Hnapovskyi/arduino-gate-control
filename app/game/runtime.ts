import type { GameSfxId } from "./audio.ts";
import {
  BOSS_BALANCE,
  DIFFICULTY_BALANCE,
  ENEMY_BALANCE,
  getDifficultyScore,
  getThreatLevel,
  MAX_RUN_DURATION_MS,
  MODE_BALANCE,
  POWER_UP_BALANCE,
} from "./balance.ts";
import {
  activatePowerUp,
  addUpgradeStack,
  isPowerUpActive,
  selectUpgradeChoices,
} from "./powerUps.ts";
import {
  combineSeed,
  hashSeed,
  nextSeededValue,
  type SeedInput,
} from "./rng.ts";
import {
  POWER_UP_IDS,
  type BossId,
  type DifficultyId,
  type EnemyArchetypeId,
  type GameModeId,
  type PowerUpId,
  type PowerUpRuntimeState,
  type RunController,
  type RunControllerSource,
  type RunMetrics,
  type RunSectorMetric,
  type SectorId,
  type UpgradeId,
  type UpgradeStacks,
  type WavePhaseKind,
  type WavePlan,
} from "./types.ts";
import { createWavePlan, isFinalModeWave } from "./waves.ts";

export const GAME_WORLD_WIDTH = 900;
export const GAME_WORLD_HEIGHT = 540;
export const MAX_GAME_SCORE = 100_000_000;
export const MAX_RUNTIME_DELTA_MS = 250;
const PHYSICS_SLICE_MS = 20;
const MAX_PLAYER_BULLETS = 140;
const MAX_ENEMY_BULLETS = 180;
const MAX_ENEMIES = 72;
const MAX_EFFECTS = 96;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u;

export type GameWorldStatus = "playing" | "upgrade" | "won" | "over";
export type GameResultOutcome = "victory" | "defeat" | "duration-limit";
export type ProjectileOwner = "player" | "drone" | "enemy";
export type ProjectileKind = "bullet" | "laser" | "missile" | "orb";
export type PickupKind = "energy" | "power";
export type HitEffectKind =
  | "hit"
  | "explosion"
  | "shield"
  | "pickup"
  | "spawn"
  | "emp"
  | "pulse"
  | "dash";

export type GameWorldInput = {
  moveX: number;
  moveY: number;
  fire: boolean;
  power: boolean;
  controller?: RunController;
};

export type PlayerRuntime = {
  x: number;
  y: number;
  radius: number;
  lives: number;
  maxLives: number;
  shield: number;
  maxShield: number;
  energy: number;
  maxEnergy: number;
  invulnerableUntilMs: number;
  fireCooldownUntilMs: number;
  droneCooldownUntilMs: number;
  missileCooldownUntilMs: number;
};

export type EnemyRuntime = {
  id: string;
  archetype: EnemyArchetypeId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  health: number;
  maxHealth: number;
  speed: number;
  elite: boolean;
  ageMs: number;
  fireCooldownUntilMs: number;
  abilityCooldownUntilMs: number;
  buffedUntilMs: number;
  stunnedUntilMs: number;
  rotation: number;
  spin: number;
  childGeneration: number;
  contactDamage: number;
};

export type BossRuntime = {
  id: string;
  bossId: BossId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  health: number;
  maxHealth: number;
  phase: number;
  ageMs: number;
  fireCooldownUntilMs: number;
  abilityCooldownUntilMs: number;
  summonCooldownUntilMs: number;
  dashUntilMs: number;
  stunnedUntilMs: number;
  invulnerableUntilMs: number;
  rotation: number;
};

export type ProjectileRuntime = {
  id: string;
  owner: ProjectileOwner;
  kind: ProjectileKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  damage: number;
  pierce: number;
  expiresAtMs: number;
  targetId: string | null;
  hitCounted: boolean;
  hitTargetIds: string[];
  color: string;
};

export type PickupRuntime = {
  id: string;
  kind: PickupKind;
  powerUpId: PowerUpId | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  value: number;
  expiresAtMs: number;
};

export type HitEffectRuntime = {
  id: string;
  kind: HitEffectKind;
  x: number;
  y: number;
  radius: number;
  color: string;
  createdAtMs: number;
  expiresAtMs: number;
};

export type GameResultSummary = {
  runId: string;
  outcome: GameResultOutcome;
  mode: GameModeId;
  difficulty: DifficultyId;
  score: number;
  level: number;
  wave: number;
  sector: SectorId;
  durationMs: number;
  lives: number;
  controller: RunController;
  upgrades: UpgradeStacks;
  equippedPowerUp: PowerUpId;
  metrics: RunMetrics;
};

export type GameToastId =
  | "elite-arrival"
  | "power-collected"
  | "power-ready"
  | "power-cooldown"
  | "power-low-energy"
  | "power-not-needed"
  | "sector-clear"
  | "low-health"
  | "victory";

export type GameEvent =
  | { type: "sfx"; id: GameSfxId }
  | { type: "toast"; id: GameToastId; value?: string | number }
  | {
      type: "upgrade";
      action: "offered" | "selected";
      choices: readonly UpgradeId[];
      selected?: UpgradeId;
    }
  | {
      type: "wave";
      action: "start" | "phase" | "complete";
      wave: number;
      phase: WavePhaseKind;
      sector: SectorId;
    }
  | {
      type: "boss";
      action: "spawn" | "phase" | "defeated";
      bossId: BossId;
      phase: number;
    }
  | { type: "result"; result: GameResultSummary };

type MutableRunMetrics = Omit<RunMetrics, "powerUpsUsed" | "sectors"> & {
  powerUpsUsed: PowerUpId[];
  sectors: RunSectorMetric[];
};

export type GameWorld = {
  width: number;
  height: number;
  runId: string;
  mode: GameModeId;
  difficulty: DifficultyId;
  seed: number;
  rngState: number;
  nextEntityId: number;
  status: GameWorldStatus;
  result: GameResultSummary | null;
  elapsedMs: number;
  activeDurationMs: number;
  score: number;
  combo: number;
  comboExpiresAtMs: number;
  controller: RunController;
  controllerSources: RunControllerSource[];
  wave: number;
  sector: SectorId;
  wavePlan: WavePlan;
  waveElapsedMs: number;
  wavePhase: WavePhaseKind;
  spawnCursor: number;
  bossSpawned: boolean;
  damageTakenThisWave: boolean;
  upgradeChoices: UpgradeId[];
  upgradeStacks: UpgradeStacks;
  equippedPowerUp: PowerUpId;
  powerStates: Partial<Record<PowerUpId, PowerUpRuntimeState>>;
  previousPowerInput: boolean;
  player: PlayerRuntime;
  enemies: EnemyRuntime[];
  boss: BossRuntime | null;
  playerProjectiles: ProjectileRuntime[];
  enemyProjectiles: ProjectileRuntime[];
  pickups: PickupRuntime[];
  effects: HitEffectRuntime[];
  events: GameEvent[];
  metrics: MutableRunMetrics;
  hazardCooldownUntilMs: number;
  screenShake: number;
};

export type SpawnEnemyOptions = {
  x?: number;
  y?: number;
  elite?: boolean;
  healthMultiplier?: number;
  speedMultiplier?: number;
  childGeneration?: number;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function magnitude(x: number, y: number) {
  return Math.hypot(x, y);
}

function normalized(x: number, y: number) {
  const length = Math.max(0.0001, magnitude(x, y));
  return { x: x / length, y: y / length };
}

function circlesTouch(
  leftX: number,
  leftY: number,
  leftRadius: number,
  rightX: number,
  rightY: number,
  rightRadius: number,
) {
  const dx = leftX - rightX;
  const dy = leftY - rightY;
  const combined = leftRadius + rightRadius;
  return dx * dx + dy * dy <= combined * combined;
}

function random(world: GameWorld) {
  const next = nextSeededValue(world.rngState);
  world.rngState = next.state;
  return next.value;
}

function randomRange(world: GameWorld, minimum: number, maximum: number) {
  return minimum + random(world) * (maximum - minimum);
}

function chance(world: GameWorld, probability: number) {
  return random(world) < clamp(probability, 0, 1);
}

function entityId(world: GameWorld, prefix: string) {
  world.nextEntityId++;
  return `${prefix}-${world.nextEntityId}`;
}

function emit(world: GameWorld, event: GameEvent) {
  world.events.push(event);
}

function addEffect(
  world: GameWorld,
  kind: HitEffectKind,
  x: number,
  y: number,
  radius: number,
  color: string,
  durationMs = 420,
) {
  world.effects.push({
    id: entityId(world, "fx"),
    kind,
    x,
    y,
    radius,
    color,
    createdAtMs: world.elapsedMs,
    expiresAtMs: world.elapsedMs + durationMs,
  });
  if (world.effects.length > MAX_EFFECTS) {
    world.effects.splice(0, world.effects.length - MAX_EFFECTS);
  }
}

function activePower(world: GameWorld, id: PowerUpId) {
  const state = world.powerStates[id];
  return Boolean(state && isPowerUpActive(state, world.elapsedMs));
}

function upgradeCount(world: GameWorld, id: UpgradeId) {
  return world.upgradeStacks[id] ?? 0;
}

function wavePhaseFor(world: GameWorld) {
  const elapsed = world.waveElapsedMs;
  const planned = world.wavePlan.phases.find(
    (phase) =>
      elapsed >= phase.startsAtMs &&
      elapsed < phase.startsAtMs + phase.durationMs,
  );
  return planned?.kind ?? "rest";
}

function createMetrics(sector: SectorId): MutableRunMetrics {
  return {
    enemiesDestroyed: 0,
    bossesDefeated: 0,
    shotsFired: 0,
    shotsHit: 0,
    longestCombo: 0,
    powerUpsCollected: 0,
    powerUpsUsed: [],
    powerUpsCollectedById: {},
    powerUpsActivatedById: {},
    flawlessSectors: 0,
    livesLost: 0,
    sectors: [
      {
        wave: 1,
        sectorId: sector,
        durationMs: 0,
        completed: false,
        livesLost: 0,
      },
    ],
  };
}

function currentSectorMetric(world: GameWorld) {
  const existing = world.metrics.sectors.find(
    (sector) => sector.wave === world.wave,
  );
  if (existing) return existing;
  const metric: RunSectorMetric = {
    wave: world.wave,
    sectorId: world.sector,
    durationMs: 0,
    completed: false,
    livesLost: 0,
  };
  world.metrics.sectors.push(metric);
  return metric;
}

function observeController(world: GameWorld, controller: RunController) {
  if (world.controller === "mixed" || controller === "mixed") {
    world.controller = "mixed";
    return;
  }
  if (!world.controllerSources.includes(controller)) {
    world.controllerSources.push(controller);
    world.controllerSources.sort();
  }
  world.controller =
    world.controllerSources.length > 1
      ? "mixed"
      : (world.controllerSources[0] ?? controller);
}

function cloneMetrics(metrics: RunMetrics): RunMetrics {
  return {
    ...metrics,
    powerUpsUsed: [...metrics.powerUpsUsed],
    powerUpsCollectedById: { ...metrics.powerUpsCollectedById },
    powerUpsActivatedById: { ...metrics.powerUpsActivatedById },
    sectors: metrics.sectors.map((sector) => ({ ...sector })),
  };
}

function createPlayer(): PlayerRuntime {
  return {
    x: GAME_WORLD_WIDTH / 2,
    y: GAME_WORLD_HEIGHT - 72,
    radius: 20,
    lives: 3,
    maxLives: 3,
    shield: 100,
    maxShield: 100,
    energy: 100,
    maxEnergy: 100,
    invulnerableUntilMs: 0,
    fireCooldownUntilMs: 0,
    droneCooldownUntilMs: 0,
    missileCooldownUntilMs: 0,
  };
}

function initialWavePlan(
  mode: GameModeId,
  difficulty: DifficultyId,
  seed: number,
) {
  return createWavePlan({ mode, difficulty, wave: 1, seed });
}

export function createGameWorld(
  runId: string,
  mode: GameModeId,
  difficulty: DifficultyId,
  seed: SeedInput,
): GameWorld {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new RangeError("Run ID must contain 8-64 safe ASCII characters.");
  }
  if (!(mode in MODE_BALANCE)) throw new RangeError("Unknown game mode.");
  if (!(difficulty in DIFFICULTY_BALANCE)) {
    throw new RangeError("Unknown game difficulty.");
  }

  const numericSeed = hashSeed(combineSeed(seed, runId, mode, difficulty));
  const wavePlan = initialWavePlan(mode, difficulty, numericSeed);
  const world: GameWorld = {
    width: GAME_WORLD_WIDTH,
    height: GAME_WORLD_HEIGHT,
    runId,
    mode,
    difficulty,
    seed: numericSeed,
    rngState: hashSeed(combineSeed(numericSeed, "runtime")),
    nextEntityId: 0,
    status: "playing",
    result: null,
    elapsedMs: 0,
    activeDurationMs: 0,
    score: 0,
    combo: 0,
    comboExpiresAtMs: 0,
    controller: "keyboard",
    controllerSources: [],
    wave: 1,
    sector: wavePlan.sector,
    wavePlan,
    waveElapsedMs: 0,
    wavePhase: "telegraph",
    spawnCursor: 0,
    bossSpawned: false,
    damageTakenThisWave: false,
    upgradeChoices: [],
    upgradeStacks: {},
    equippedPowerUp: "shield",
    powerStates: {},
    previousPowerInput: false,
    player: createPlayer(),
    enemies: [],
    boss: null,
    playerProjectiles: [],
    enemyProjectiles: [],
    pickups: [],
    effects: [],
    events: [],
    metrics: createMetrics(wavePlan.sector),
    hazardCooldownUntilMs: 0,
    screenShake: 0,
  };

  emit(world, {
    type: "wave",
    action: "start",
    wave: 1,
    phase: "telegraph",
    sector: wavePlan.sector,
  });
  return world;
}

export function spawnEnemy(
  world: GameWorld,
  archetype: EnemyArchetypeId,
  options: SpawnEnemyOptions = {},
) {
  const config = ENEMY_BALANCE[archetype];
  const elite = Boolean(options.elite && config.canBeElite);
  const healthMultiplier =
    DIFFICULTY_BALANCE[world.difficulty].enemyHealthMultiplier *
    (options.healthMultiplier ?? 1) *
    (elite ? 1.75 : 1);
  const speedMultiplier =
    DIFFICULTY_BALANCE[world.difficulty].enemySpeedMultiplier *
    (options.speedMultiplier ?? 1) *
    (elite ? 1.12 : 1);
  const radius = config.radius * (elite ? 1.12 : 1);
  const x = options.x ?? randomRange(world, radius + 8, world.width - radius - 8);
  const y = options.y ?? -radius - 12;
  const horizontalSign = chance(world, 0.5) ? -1 : 1;
  const speed = config.baseSpeed * speedMultiplier;
  let vx = randomRange(world, -24, 24);
  let vy = speed;

  if (archetype === "comet") {
    vx = horizontalSign * speed * 0.42;
    vy = speed;
  } else if (archetype === "debris") {
    vx = horizontalSign * randomRange(world, 28, 72);
  } else if (archetype === "mine") {
    vx = 0;
    vy = speed;
  } else if (archetype.endsWith("drone")) {
    vx = horizontalSign * speed * 0.35;
    vy = speed * 0.55;
  }

  const enemy: EnemyRuntime = {
    id: entityId(world, "enemy"),
    archetype,
    x,
    y,
    vx,
    vy,
    radius,
    health: Math.max(1, Math.round(config.baseHealth * healthMultiplier)),
    maxHealth: Math.max(1, Math.round(config.baseHealth * healthMultiplier)),
    speed,
    elite,
    ageMs: 0,
    fireCooldownUntilMs: world.elapsedMs + randomRange(world, 600, 1_300),
    abilityCooldownUntilMs: world.elapsedMs + randomRange(world, 1_000, 2_000),
    buffedUntilMs: 0,
    stunnedUntilMs: 0,
    rotation: randomRange(world, 0, Math.PI * 2),
    spin: randomRange(world, -2.2, 2.2),
    childGeneration: options.childGeneration ?? 0,
    contactDamage: Math.round(
      (elite ? 45 : 34) *
        DIFFICULTY_BALANCE[world.difficulty].enemyDamageMultiplier,
    ),
  };
  world.enemies.push(enemy);
  if (elite) {
    emit(world, { type: "toast", id: "elite-arrival", value: archetype });
  }
  addEffect(world, "spawn", x, y, radius * 1.6, elite ? "#ffd166" : "#56d7bf");
  return enemy;
}

export function spawnBoss(
  world: GameWorld,
  bossId: BossId,
  healthMultiplier = 1,
) {
  const config = BOSS_BALANCE[bossId];
  const health = Math.max(
    1,
    Math.round(
      config.baseHealth *
        healthMultiplier *
        DIFFICULTY_BALANCE[world.difficulty].enemyHealthMultiplier,
    ),
  );
  const boss: BossRuntime = {
    id: entityId(world, "boss"),
    bossId,
    x: world.width / 2,
    y: -72,
    vx: 0,
    vy: 70,
    radius:
      bossId === "void-dreadnought"
        ? 66
        : bossId === "comet-leviathan"
          ? 58
          : 52,
    health,
    maxHealth: health,
    phase: 1,
    ageMs: 0,
    fireCooldownUntilMs: world.elapsedMs + 900,
    abilityCooldownUntilMs: world.elapsedMs + 2_000,
    summonCooldownUntilMs: world.elapsedMs + 4_500,
    dashUntilMs: 0,
    stunnedUntilMs: 0,
    invulnerableUntilMs: world.elapsedMs + 900,
    rotation: 0,
  };
  world.boss = boss;
  world.bossSpawned = true;
  addEffect(world, "spawn", boss.x, 72, boss.radius * 2, "#ff6b3d", 900);
  emit(world, { type: "sfx", id: "BOSS" });
  emit(world, { type: "boss", action: "spawn", bossId, phase: 1 });
  return boss;
}

function addProjectile(
  world: GameWorld,
  projectile: Omit<ProjectileRuntime, "id">,
) {
  const target =
    projectile.owner === "enemy"
      ? world.enemyProjectiles
      : world.playerProjectiles;
  const maximum =
    projectile.owner === "enemy" ? MAX_ENEMY_BULLETS : MAX_PLAYER_BULLETS;
  target.push({ ...projectile, id: entityId(world, "shot") });
  if (target.length > maximum) target.splice(0, target.length - maximum);
}

function aimedVelocity(
  fromX: number,
  fromY: number,
  targetX: number,
  targetY: number,
  speed: number,
) {
  const direction = normalized(targetX - fromX, targetY - fromY);
  return { x: direction.x * speed, y: direction.y * speed };
}

function fireEnemyProjectile(
  world: GameWorld,
  x: number,
  y: number,
  angle: number,
  speed: number,
  damage: number,
  radius = 5,
  color = "#ff8f70",
) {
  const difficulty = DIFFICULTY_BALANCE[world.difficulty];
  const scaledSpeed = speed * difficulty.enemySpeedMultiplier;
  addProjectile(world, {
    owner: "enemy",
    kind: "orb",
    x,
    y,
    vx: Math.cos(angle) * scaledSpeed,
    vy: Math.sin(angle) * scaledSpeed,
    radius,
    damage: Math.max(
      1,
      Math.round(damage * difficulty.enemyDamageMultiplier),
    ),
    pierce: 0,
    expiresAtMs: world.elapsedMs + 7_000,
    targetId: null,
    hitCounted: false,
    hitTargetIds: [],
    color,
  });
}

function fireAimedEnemyProjectile(
  world: GameWorld,
  x: number,
  y: number,
  speed: number,
  damage: number,
  spread = 0,
) {
  const velocity = aimedVelocity(
    x,
    y,
    world.player.x,
    world.player.y,
    speed,
  );
  const baseAngle = Math.atan2(velocity.y, velocity.x);
  fireEnemyProjectile(world, x, y, baseAngle + spread, speed, damage);
}

function fireRadialBurst(
  world: GameWorld,
  x: number,
  y: number,
  count: number,
  speed: number,
  damage: number,
  offset = 0,
) {
  for (let index = 0; index < count; index++) {
    fireEnemyProjectile(
      world,
      x,
      y,
      offset + (index / count) * Math.PI * 2,
      speed,
      damage,
      5,
      "#ff7a9d",
    );
  }
}

function addPickup(
  world: GameWorld,
  x: number,
  y: number,
  forcedPowerUp?: PowerUpId,
) {
  const powerDrop = forcedPowerUp !== undefined || chance(world, 0.56);
  const powerUpId =
    forcedPowerUp ??
    (POWER_UP_IDS[Math.floor(random(world) * POWER_UP_IDS.length)] as PowerUpId);
  world.pickups.push({
    id: entityId(world, "pickup"),
    kind: powerDrop ? "power" : "energy",
    powerUpId: powerDrop ? powerUpId : null,
    x,
    y,
    vx: randomRange(world, -28, 28),
    vy: randomRange(world, 38, 62),
    radius: 12,
    value: powerDrop ? 0 : 28,
    expiresAtMs: world.elapsedMs + 13_000,
  });
}

function equipCollectedPowerUp(world: GameWorld, powerUpId: PowerUpId) {
  world.metrics.powerUpsCollectedById[powerUpId] =
    (world.metrics.powerUpsCollectedById[powerUpId] ?? 0) + 1;
  world.equippedPowerUp = powerUpId;
  emit(world, {
    type: "toast",
    id: "power-collected",
    value: powerUpId,
  });
}

export function awardScore(world: GameWorld, baseScore: number) {
  if (world.result) return world.score;
  const comboTier = Math.min(5, Math.floor(Math.max(0, world.combo - 1) / 5));
  const withCombo = Math.max(0, baseScore) * (1 + comboTier * 0.1);
  const earned = getDifficultyScore(withCombo, world.difficulty);
  world.score = Math.min(
    MAX_GAME_SCORE,
    Math.max(0, Math.round((world.score + earned) / 10) * 10),
  );
  return world.score;
}

function markHit(world: GameWorld, projectile: ProjectileRuntime) {
  if (!projectile.hitCounted) {
    projectile.hitCounted = true;
    world.metrics.shotsHit++;
  }
}

function hasHitTarget(projectile: ProjectileRuntime, targetId: string) {
  return projectile.hitTargetIds.includes(targetId);
}

function rememberHitTarget(projectile: ProjectileRuntime, targetId: string) {
  if (!hasHitTarget(projectile, targetId)) {
    projectile.hitTargetIds.push(targetId);
  }
}

function splitEnemy(world: GameWorld, enemy: EnemyRuntime) {
  if (
    enemy.archetype !== "splitter-asteroid" ||
    enemy.childGeneration >= 1 ||
    world.enemies.length >= MAX_ENEMIES - 2
  ) {
    return;
  }
  for (const direction of [-1, 1]) {
    const child = spawnEnemy(world, "swift-asteroid", {
      x: enemy.x + direction * enemy.radius * 0.35,
      y: enemy.y,
      elite: false,
      healthMultiplier: 1,
      speedMultiplier: 1.18,
      childGeneration: enemy.childGeneration + 1,
    });
    child.radius *= 0.78;
    child.vx = direction * child.speed * 0.48;
    child.vy = child.speed * 0.88;
  }
}

function defeatEnemy(world: GameWorld, enemy: EnemyRuntime) {
  const index = world.enemies.indexOf(enemy);
  if (index < 0) return;
  world.enemies.splice(index, 1);
  splitEnemy(world, enemy);
  world.metrics.enemiesDestroyed++;
  world.combo = world.elapsedMs <= world.comboExpiresAtMs ? world.combo + 1 : 1;
  world.comboExpiresAtMs = world.elapsedMs + 2_600;
  world.metrics.longestCombo = Math.max(world.metrics.longestCombo, world.combo);
  const config = ENEMY_BALANCE[enemy.archetype];
  awardScore(world, config.score * (enemy.elite ? 2 : 1));
  world.player.energy = Math.min(
    world.player.maxEnergy,
    world.player.energy + (enemy.elite ? 12 : 6),
  );
  addEffect(
    world,
    "explosion",
    enemy.x,
    enemy.y,
    enemy.radius * 1.8,
    enemy.elite ? "#ffd166" : "#f2b68d",
  );
  world.screenShake = Math.max(world.screenShake, enemy.elite ? 7 : 3);
  emit(world, { type: "sfx", id: "SCORE" });

  const dropChance =
    0.09 * DIFFICULTY_BALANCE[world.difficulty].recoveryDropMultiplier +
    (enemy.elite ? 0.16 : 0);
  if (chance(world, dropChance)) addPickup(world, enemy.x, enemy.y);
}

function bossPhaseFor(boss: BossRuntime) {
  const thresholds = BOSS_BALANCE[boss.bossId].phaseThresholds;
  const ratio = boss.health / boss.maxHealth;
  let phase = 1;
  for (const threshold of thresholds) {
    if (ratio <= threshold) phase++;
  }
  return phase;
}

function defeatBoss(world: GameWorld, boss: BossRuntime) {
  if (world.boss !== boss) return;
  world.boss = null;
  world.metrics.bossesDefeated++;
  awardScore(world, BOSS_BALANCE[boss.bossId].score);
  world.player.energy = world.player.maxEnergy;
  const signatureReward: Record<BossId, PowerUpId> = {
    "sentinel-array": "laser",
    "comet-leviathan": "time",
    "void-dreadnought": "charge",
  };
  const reward = signatureReward[boss.bossId];
  world.metrics.powerUpsCollected++;
  equipCollectedPowerUp(world, reward);
  addEffect(world, "pickup", boss.x, boss.y, 36, "#d7f55a", 520);
  emit(world, { type: "sfx", id: "POWER" });
  addEffect(world, "explosion", boss.x, boss.y, boss.radius * 3, "#ff6b3d", 900);
  world.screenShake = Math.max(world.screenShake, 14);
  emit(world, { type: "sfx", id: "BOSS" });
  emit(world, {
    type: "boss",
    action: "defeated",
    bossId: boss.bossId,
    phase: boss.phase,
  });
}

function damageEnemy(
  world: GameWorld,
  enemy: EnemyRuntime,
  amount: number,
  projectile?: ProjectileRuntime,
) {
  if (amount <= 0) return;
  const armor = enemy.archetype === "armored-asteroid" ? 0.72 : 1;
  enemy.health -= Math.max(0.25, amount * armor);
  if (projectile) markHit(world, projectile);
  addEffect(world, "hit", enemy.x, enemy.y, 12, "#fff4a4", 180);
  if (enemy.health <= 0) defeatEnemy(world, enemy);
}

function damageBoss(
  world: GameWorld,
  boss: BossRuntime,
  amount: number,
  projectile?: ProjectileRuntime,
) {
  if (amount <= 0 || world.elapsedMs < boss.invulnerableUntilMs) return;
  boss.health -= amount;
  if (projectile) markHit(world, projectile);
  addEffect(world, "hit", boss.x, boss.y, 18, "#ffffff", 190);
  if (boss.health <= 0) {
    defeatBoss(world, boss);
    return;
  }
  const nextPhase = bossPhaseFor(boss);
  if (nextPhase !== boss.phase) {
    boss.phase = nextPhase;
    boss.invulnerableUntilMs = world.elapsedMs + 520;
    boss.fireCooldownUntilMs = world.elapsedMs + 360;
    boss.abilityCooldownUntilMs = world.elapsedMs + 800;
    addEffect(world, "pulse", boss.x, boss.y, boss.radius * 2.3, "#ff6b3d", 650);
    emit(world, { type: "sfx", id: "WARN" });
    emit(world, {
      type: "boss",
      action: "phase",
      bossId: boss.bossId,
      phase: nextPhase,
    });
  }
}

function damagePlayer(world: GameWorld, amount: number) {
  const player = world.player;
  if (world.elapsedMs < player.invulnerableUntilMs || world.result) return;
  if (activePower(world, "invulnerability")) return;

  world.damageTakenThisWave = true;
  const incoming = Math.max(1, amount);
  if (player.shield > 0 || activePower(world, "shield")) {
    const shieldPool = Math.max(player.shield, activePower(world, "shield") ? 1 : 0);
    player.shield = Math.max(0, shieldPool - incoming);
    player.invulnerableUntilMs = world.elapsedMs + 260;
    addEffect(world, "shield", player.x, player.y, 34, "#68e1ff", 260);
    emit(world, { type: "sfx", id: "SHIELD" });
    return;
  }

  player.lives = Math.max(0, player.lives - 1);
  world.metrics.livesLost++;
  currentSectorMetric(world).livesLost++;
  player.invulnerableUntilMs =
    world.elapsedMs + 1_300 + upgradeCount(world, "phase-plating") * 350;
  player.shield = Math.round(player.maxShield * 0.35);
  world.combo = 0;
  world.screenShake = Math.max(world.screenShake, 11);
  addEffect(world, "explosion", player.x, player.y, 42, "#ff6b3d", 600);
  emit(world, { type: "sfx", id: "CRASH" });
  if (player.lives === 1) {
    emit(world, { type: "sfx", id: "LOW" });
    emit(world, { type: "toast", id: "low-health" });
  }
  if (player.lives === 0) finishWorld(world, "defeat");
}

function createSummary(
  world: GameWorld,
  outcome: GameResultOutcome,
): GameResultSummary {
  return {
    runId: world.runId,
    outcome,
    mode: world.mode,
    difficulty: world.difficulty,
    score: Math.min(MAX_GAME_SCORE, Math.floor(world.score / 10) * 10),
    level: getThreatLevel(world.activeDurationMs),
    wave: world.wave,
    sector: world.sector,
    durationMs: Math.min(MAX_RUN_DURATION_MS, Math.round(world.activeDurationMs)),
    lives: world.player.lives,
    controller: world.controller,
    upgrades: { ...world.upgradeStacks },
    equippedPowerUp: world.equippedPowerUp,
    metrics: cloneMetrics(world.metrics),
  };
}

function finishWorld(world: GameWorld, outcome: GameResultOutcome) {
  if (world.result) return world.result;
  world.status = outcome === "victory" ? "won" : "over";
  world.result = createSummary(world, outcome);
  world.enemyProjectiles = [];
  if (outcome === "victory") emit(world, { type: "toast", id: "victory" });
  emit(world, { type: "result", result: world.result });
  return world.result;
}

export function snapshotGameSummary(world: GameWorld) {
  const summary = world.result ?? createSummary(world, "defeat");
  return {
    ...summary,
    upgrades: { ...summary.upgrades },
    metrics: cloneMetrics(summary.metrics),
  };
}

function powerSfx(id: PowerUpId): GameSfxId {
  if (id === "shield" || id === "invulnerability") return "SHIELD";
  if (id === "laser" || id === "charge") return "LASER";
  if (id === "missiles") return "MISSILE";
  if (id === "emp") return "EMP";
  return "POWER";
}

function recordPowerUse(world: GameWorld, id: PowerUpId) {
  world.metrics.powerUpsActivatedById[id] =
    (world.metrics.powerUpsActivatedById[id] ?? 0) + 1;
  if (!world.metrics.powerUpsUsed.includes(id)) {
    world.metrics.powerUpsUsed.push(id);
    world.metrics.powerUpsUsed.sort();
  }
}

function empBlast(world: GameWorld, state: PowerUpRuntimeState) {
  addEffect(
    world,
    "emp",
    world.player.x,
    world.player.y,
    290,
    "#9affff",
    POWER_UP_BALANCE.emp.durationMs,
  );
  for (const enemy of [...world.enemies]) {
    enemy.stunnedUntilMs = state.activeUntilMs;
    damageEnemy(world, enemy, 3 + upgradeCount(world, "emp-capacitor"));
  }
  if (world.boss) {
    world.boss.stunnedUntilMs = Math.min(
      state.activeUntilMs,
      world.elapsedMs + 1_200,
    );
    damageBoss(world, world.boss, 5 + upgradeCount(world, "emp-capacitor"));
  }
  world.enemyProjectiles = [];
}

function repulsorPulse(world: GameWorld) {
  const origin = world.player;
  addEffect(world, "pulse", origin.x, origin.y, 230, "#d7f55a", 750);
  for (const enemy of [...world.enemies]) {
    const direction = normalized(enemy.x - origin.x, enemy.y - origin.y);
    enemy.vx += direction.x * 260;
    enemy.vy += direction.y * 260;
    damageEnemy(world, enemy, 2);
  }
  if (world.boss) {
    damageBoss(world, world.boss, 3);
  }
  world.enemyProjectiles = world.enemyProjectiles.filter(
    (shot) =>
      magnitude(shot.x - origin.x, shot.y - origin.y) > 260,
  );
  world.screenShake = Math.max(world.screenShake, 8);
}

function chargedAttack(world: GameWorld) {
  addProjectile(world, {
    owner: "player",
    kind: "laser",
    x: world.player.x,
    y: world.player.y - 28,
    vx: 0,
    vy: -880,
    radius: 18,
    damage: 16,
    pierce: 12,
    expiresAtMs: world.elapsedMs + 1_500,
    targetId: null,
    hitCounted: false,
    hitTargetIds: [],
    color: "#fff4a4",
  });
  world.metrics.shotsFired++;
  addEffect(world, "pulse", world.player.x, world.player.y, 70, "#fff4a4", 420);
  world.screenShake = Math.max(world.screenShake, 6);
}

export function activateEquippedSuperpower(world: GameWorld) {
  if (world.status !== "playing" || world.result) return false;
  const id = world.equippedPowerUp;
  if (
    id === "repair" &&
    world.player.lives >= world.player.maxLives &&
    world.player.shield >= world.player.maxShield
  ) {
    emit(world, { type: "toast", id: "power-not-needed", value: id });
    return false;
  }
  const previous = world.powerStates[id] ?? null;
  const capacitorStacks =
    id === "emp" ? upgradeCount(world, "emp-capacitor") : 0;
  const capacitorDiscount = capacitorStacks * 8;
  const cost = Math.max(0, POWER_UP_BALANCE[id].energyCost - capacitorDiscount);
  if (world.player.energy < cost) {
    emit(world, { type: "toast", id: "power-low-energy", value: id });
    return false;
  }
  const activation = activatePowerUp(
    id,
    world.elapsedMs,
    world.player.energy + capacitorDiscount,
    previous,
  );
  if (!activation) {
    emit(world, { type: "toast", id: "power-cooldown", value: id });
    return false;
  }

  if (id === "emp" && capacitorStacks > 0) {
    activation.cooldownUntilMs = Math.max(
      activation.activeUntilMs,
      activation.cooldownUntilMs - capacitorStacks * 1_000,
    );
  }

  world.powerStates[id] = activation;
  world.player.energy = Math.max(0, world.player.energy - cost);
  recordPowerUse(world, id);
  emit(world, { type: "sfx", id: powerSfx(id) });
  emit(world, { type: "toast", id: "power-ready", value: id });

  if (id === "shield") {
    world.player.shield = world.player.maxShield;
  } else if (id === "repair") {
    world.player.lives = Math.min(world.player.maxLives, world.player.lives + 1);
    world.player.shield = Math.max(
      world.player.shield,
      Math.round(world.player.maxShield * 0.55),
    );
  } else if (id === "emp") {
    empBlast(world, activation);
  } else if (id === "pulse") {
    repulsorPulse(world);
  } else if (id === "charge") {
    chargedAttack(world);
  } else if (id === "invulnerability") {
    world.player.invulnerableUntilMs = activation.activeUntilMs;
  }
  return true;
}

function nearestEnemy(world: GameWorld, x: number, y: number) {
  let closest: EnemyRuntime | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const enemy of world.enemies) {
    const distance = (enemy.x - x) ** 2 + (enemy.y - y) ** 2;
    if (distance < closestDistance) {
      closest = enemy;
      closestDistance = distance;
    }
  }
  return closest;
}

function addPlayerProjectile(
  world: GameWorld,
  x: number,
  y: number,
  angle: number,
  kind: ProjectileKind = "bullet",
  owner: ProjectileOwner = "player",
) {
  const criticalChance =
    upgradeCount(world, "critical-focus") * 0.08 +
    (activePower(world, "critical") ? 0.32 : 0);
  const critical = chance(world, criticalChance);
  const speed = kind === "missile" ? 330 : kind === "laser" ? 820 : 610;
  const piercing =
    kind === "laser"
      ? 5
      : kind === "missile"
        ? 1
        : upgradeCount(world, "piercing-rounds");
  const target = kind === "missile" ? nearestEnemy(world, x, y) : null;
  addProjectile(world, {
    owner,
    kind,
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    radius: kind === "laser" ? 7 : kind === "missile" ? 8 : 4,
    damage:
      (kind === "laser" ? 3.2 : kind === "missile" ? 5 : 1) *
      (critical ? 2 : 1),
    pierce: piercing,
    expiresAtMs: world.elapsedMs + (kind === "missile" ? 4_000 : 2_200),
    targetId: target?.id ?? null,
    hitCounted: false,
    hitTargetIds: [],
    color: critical ? "#fff4a4" : kind === "missile" ? "#ffb34f" : "#d7f55a",
  });
}

function firePlayerWeapons(world: GameWorld) {
  if (world.elapsedMs < world.player.fireCooldownUntilMs) return;
  const rapidStacks = upgradeCount(world, "rapid-fire");
  const laserActive = activePower(world, "laser");
  const cooldown = laserActive
    ? 105
    : Math.max(95, Math.round(220 * 0.84 ** rapidStacks));
  world.player.fireCooldownUntilMs = world.elapsedMs + cooldown;

  const spreadActive = activePower(world, "spread");
  const twinStacks = upgradeCount(world, "twin-shot");
  const count = Math.min(5, 1 + twinStacks + (spreadActive ? 2 : 0));
  const offsets = Array.from(
    { length: count },
    (_, index) => (index - (count - 1) / 2) * 0.16,
  );
  for (const offset of offsets) {
    addPlayerProjectile(
      world,
      world.player.x + offset * 55,
      world.player.y - 24,
      -Math.PI / 2 + offset,
      laserActive ? "laser" : "bullet",
    );
  }
  world.metrics.shotsFired += offsets.length;
  emit(world, { type: "sfx", id: laserActive ? "LASER" : "SHOT" });
}

function fireMissile(world: GameWorld, owner: ProjectileOwner = "player") {
  addPlayerProjectile(
    world,
    world.player.x + (owner === "drone" ? 28 : 0),
    world.player.y - 18,
    -Math.PI / 2,
    "missile",
    owner,
  );
  world.metrics.shotsFired++;
  emit(world, { type: "sfx", id: "MISSILE" });
}

function updatePlayer(world: GameWorld, input: GameWorldInput, deltaMs: number) {
  const player = world.player;
  const seconds = deltaMs / 1_000;
  const moveX = clamp(Number.isFinite(input.moveX) ? input.moveX : 0, -1, 1);
  const moveY = clamp(Number.isFinite(input.moveY) ? input.moveY : 0, -1, 1);
  const baseSpeed =
    320 +
    upgradeCount(world, "engine-boost") * 26 +
    (activePower(world, "speed") ? 90 : 0);
  const sectorSlow = world.sector === "ice" ? 0.86 : 1;
  const solarDrift =
    world.sector === "solar" ? Math.sin(world.elapsedMs / 520) * 34 : 0;
  player.x = clamp(
    player.x + (moveX * baseSpeed * sectorSlow + solarDrift) * seconds,
    player.radius + 8,
    world.width - player.radius - 8,
  );
  player.y = clamp(
    player.y + moveY * baseSpeed * sectorSlow * seconds,
    player.radius + 8,
    world.height - player.radius - 8,
  );

  if (input.controller) observeController(world, input.controller);
  if (world.elapsedMs > world.comboExpiresAtMs) world.combo = 0;
  const nanites = upgradeCount(world, "repair-nanites");
  if (nanites > 0 && player.shield < player.maxShield) {
    player.shield = Math.min(
      player.maxShield,
      player.shield + nanites * 1.7 * seconds,
    );
  }

  if (input.fire) firePlayerWeapons(world);
  const powerPressed = Boolean(input.power);
  if (powerPressed && !world.previousPowerInput) {
    activateEquippedSuperpower(world);
  }
  world.previousPowerInput = powerPressed;

  const escortStacks = upgradeCount(world, "escort-drone");
  const droneCount = Math.max(activePower(world, "drone") ? 1 : 0, escortStacks);
  if (droneCount > 0 && world.elapsedMs >= player.droneCooldownUntilMs) {
    player.droneCooldownUntilMs = world.elapsedMs + 480;
    const droneOffsets = droneCount === 1 ? [30] : [-30, 30];
    for (const offset of droneOffsets) {
      const originX = player.x + offset;
      const target = nearestEnemy(world, originX, player.y) ?? world.boss;
      const angle = target
        ? Math.atan2(target.y - player.y, target.x - originX)
        : -Math.PI / 2;
      addPlayerProjectile(
        world,
        originX,
        player.y + 4,
        angle,
        "bullet",
        "drone",
      );
    }
    world.metrics.shotsFired += droneOffsets.length;
  }

  const missilesEnabled =
    activePower(world, "missiles") || upgradeCount(world, "missile-bay") > 0;
  if (missilesEnabled && world.elapsedMs >= player.missileCooldownUntilMs) {
    const stacks = upgradeCount(world, "missile-bay");
    player.missileCooldownUntilMs = world.elapsedMs + Math.max(620, 1_150 - stacks * 180);
    fireMissile(world);
  }
}

function removeEnemyWithoutReward(world: GameWorld, enemy: EnemyRuntime) {
  const index = world.enemies.indexOf(enemy);
  if (index >= 0) world.enemies.splice(index, 1);
}

function updateMine(world: GameWorld, enemy: EnemyRuntime) {
  if (enemy.y < 150) return;
  enemy.vy *= 0.86;
  const closeToPlayer =
    magnitude(enemy.x - world.player.x, enemy.y - world.player.y) < 145;
  if (!closeToPlayer && world.elapsedMs < enemy.abilityCooldownUntilMs + 2_700) {
    return;
  }

  fireRadialBurst(
    world,
    enemy.x,
    enemy.y,
    enemy.elite ? 12 : 8,
    enemy.elite ? 205 : 170,
    enemy.elite ? 24 : 18,
    enemy.rotation,
  );
  if (
    magnitude(enemy.x - world.player.x, enemy.y - world.player.y) <
    enemy.radius + world.player.radius + 34
  ) {
    damagePlayer(world, enemy.contactDamage);
  }
  addEffect(world, "explosion", enemy.x, enemy.y, 58, "#ff7a9d", 520);
  world.screenShake = Math.max(world.screenShake, 6);
  removeEnemyWithoutReward(world, enemy);
}

function updateSupportDrone(
  world: GameWorld,
  enemy: EnemyRuntime,
  seconds: number,
) {
  let target: EnemyRuntime | null = null;
  let lowestHealthRatio = 1;
  for (const candidate of world.enemies) {
    if (candidate === enemy) continue;
    const ratio = candidate.health / candidate.maxHealth;
    if (ratio < lowestHealthRatio) {
      target = candidate;
      lowestHealthRatio = ratio;
    }
  }

  if (target) {
    const direction = normalized(target.x - enemy.x, target.y - enemy.y);
    enemy.vx += direction.x * enemy.speed * seconds * 1.5;
    enemy.vy += direction.y * enemy.speed * seconds * 1.5;
    const velocityLength = magnitude(enemy.vx, enemy.vy);
    if (velocityLength > enemy.speed * 1.15) {
      enemy.vx = (enemy.vx / velocityLength) * enemy.speed * 1.15;
      enemy.vy = (enemy.vy / velocityLength) * enemy.speed * 1.15;
    }
  }

  if (world.elapsedMs < enemy.abilityCooldownUntilMs) return;
  enemy.abilityCooldownUntilMs = world.elapsedMs + (enemy.elite ? 950 : 1_350);
  const allies = world.enemies.filter(
    (candidate) =>
      candidate !== enemy &&
      magnitude(candidate.x - enemy.x, candidate.y - enemy.y) <= 190,
  );
  for (const ally of allies.slice(0, enemy.elite ? 4 : 2)) {
    ally.health = Math.min(ally.maxHealth, ally.health + ally.maxHealth * 0.16);
    ally.buffedUntilMs = world.elapsedMs + 2_200;
    addEffect(world, "shield", ally.x, ally.y, ally.radius * 1.4, "#9aff6b", 360);
  }
}

function updateEnemy(world: GameWorld, enemy: EnemyRuntime, deltaMs: number) {
  if (!world.enemies.includes(enemy)) return;
  const hostileTimeScale = activePower(world, "time") ? 0.46 : 1;
  const scaledMs = deltaMs * hostileTimeScale;
  const seconds = scaledMs / 1_000;
  const darkSectorMultiplier = world.sector === "dark" ? 1.12 : 1;
  const movementSeconds = seconds * darkSectorMultiplier;
  enemy.ageMs += scaledMs;
  enemy.rotation += enemy.spin * seconds;
  if (world.elapsedMs < enemy.stunnedUntilMs) return;

  const buffMultiplier = world.elapsedMs < enemy.buffedUntilMs ? 1.24 : 1;
  if (enemy.archetype === "scout-drone") {
    enemy.vx += Math.sin(enemy.ageMs / 360) * enemy.speed * seconds * 2.2;
    enemy.vx = clamp(enemy.vx, -enemy.speed, enemy.speed);
  } else if (enemy.archetype === "gunner-drone") {
    if (enemy.y > 105) enemy.vy *= 0.91;
    enemy.vx += Math.sin(enemy.ageMs / 680) * enemy.speed * seconds;
    if (world.elapsedMs >= enemy.fireCooldownUntilMs) {
      const volleys = enemy.elite ? [-0.12, 0, 0.12] : [0];
      for (const spread of volleys) {
        fireAimedEnemyProjectile(
          world,
          enemy.x,
          enemy.y,
          enemy.elite ? 270 : 225,
          enemy.elite ? 27 : 20,
          spread,
        );
      }
      enemy.fireCooldownUntilMs = world.elapsedMs + (enemy.elite ? 850 : 1_300);
    }
  } else if (enemy.archetype === "hunter-drone") {
    const direction = normalized(
      world.player.x - enemy.x,
      world.player.y - enemy.y,
    );
    enemy.vx += direction.x * enemy.speed * seconds * 2.8;
    enemy.vy += direction.y * enemy.speed * seconds * 2.8;
    const velocityLength = magnitude(enemy.vx, enemy.vy);
    if (velocityLength > enemy.speed * 1.15) {
      enemy.vx = (enemy.vx / velocityLength) * enemy.speed * 1.15;
      enemy.vy = (enemy.vy / velocityLength) * enemy.speed * 1.15;
    }
  } else if (enemy.archetype === "support-drone") {
    updateSupportDrone(world, enemy, seconds);
  } else if (enemy.archetype === "mine") {
    updateMine(world, enemy);
  } else if (enemy.archetype === "comet") {
    enemy.vx += Math.sin(enemy.ageMs / 210) * 18 * seconds;
    if (world.elapsedMs >= enemy.abilityCooldownUntilMs) {
      enemy.abilityCooldownUntilMs = world.elapsedMs + 1_700;
      addEffect(world, "dash", enemy.x, enemy.y, enemy.radius * 1.5, "#ffb34f", 260);
      enemy.vy = enemy.speed * 1.28;
    }
  } else if (enemy.archetype === "debris") {
    enemy.vx += Math.sin(enemy.ageMs / 430) * 8 * seconds;
  }

  if (
    enemy.elite &&
    !enemy.archetype.endsWith("drone") &&
    world.elapsedMs >= enemy.fireCooldownUntilMs
  ) {
    fireAimedEnemyProjectile(world, enemy.x, enemy.y, 205, 18);
    enemy.fireCooldownUntilMs = world.elapsedMs + 2_100;
  }

  enemy.x += enemy.vx * movementSeconds * buffMultiplier;
  enemy.y += enemy.vy * movementSeconds * buffMultiplier;
  if (enemy.x < -enemy.radius) enemy.x = world.width + enemy.radius;
  if (enemy.x > world.width + enemy.radius) enemy.x = -enemy.radius;
  if (enemy.y - enemy.radius > world.height + 80) {
    removeEnemyWithoutReward(world, enemy);
  }
}

function summonForBoss(
  world: GameWorld,
  archetype: EnemyArchetypeId,
  boss: BossRuntime,
  count: number,
) {
  for (let index = 0; index < count && world.enemies.length < MAX_ENEMIES; index++) {
    const angle = ((index + 1) / (count + 1)) * Math.PI;
    spawnEnemy(world, archetype, {
      x: clamp(boss.x + Math.cos(angle) * 95, 30, world.width - 30),
      y: boss.y + Math.sin(angle) * 48,
      elite: boss.phase >= 3 && chance(world, 0.3),
      healthMultiplier: 0.9,
      speedMultiplier: 1,
    });
  }
}

function syncBossPhase(world: GameWorld, boss: BossRuntime) {
  const nextPhase = bossPhaseFor(boss);
  if (nextPhase === boss.phase) return;
  boss.phase = nextPhase;
  boss.invulnerableUntilMs = world.elapsedMs + 520;
  boss.fireCooldownUntilMs = world.elapsedMs + 300;
  boss.abilityCooldownUntilMs = world.elapsedMs + 750;
  addEffect(world, "pulse", boss.x, boss.y, boss.radius * 2.3, "#ff6b3d", 650);
  emit(world, { type: "sfx", id: "WARN" });
  emit(world, {
    type: "boss",
    action: "phase",
    bossId: boss.bossId,
    phase: nextPhase,
  });
}

function updateSentinelBoss(world: GameWorld, boss: BossRuntime) {
  boss.x = world.width / 2 + Math.sin(boss.ageMs / 850) * (180 + boss.phase * 22);
  if (world.elapsedMs >= boss.fireCooldownUntilMs) {
    const count = 3 + boss.phase * 2;
    const aim = Math.atan2(world.player.y - boss.y, world.player.x - boss.x);
    for (let index = 0; index < count; index++) {
      const offset = (index - (count - 1) / 2) * 0.15;
      fireEnemyProjectile(
        world,
        boss.x,
        boss.y + 18,
        aim + offset,
        205 + boss.phase * 18,
        18 + boss.phase * 4,
      );
    }
    boss.fireCooldownUntilMs = world.elapsedMs + Math.max(480, 1_050 - boss.phase * 130);
  }
  if (boss.phase >= 2 && world.elapsedMs >= boss.summonCooldownUntilMs) {
    summonForBoss(world, boss.phase >= 3 ? "gunner-drone" : "scout-drone", boss, boss.phase);
    boss.summonCooldownUntilMs = world.elapsedMs + Math.max(3_000, 5_200 - boss.phase * 550);
  }
  if (boss.phase >= 3 && world.elapsedMs >= boss.abilityCooldownUntilMs) {
    fireRadialBurst(world, boss.x, boss.y, 12, 185, 23, boss.rotation);
    boss.abilityCooldownUntilMs = world.elapsedMs + 2_200;
  }
}

function updateLeviathanBoss(world: GameWorld, boss: BossRuntime, seconds: number) {
  if (world.elapsedMs < boss.dashUntilMs) {
    boss.x += boss.vx * seconds;
    boss.y += boss.vy * seconds;
    if (boss.x < boss.radius || boss.x > world.width - boss.radius) boss.vx *= -1;
    if (boss.y < 70 || boss.y > world.height * 0.56) boss.vy *= -1;
    if (chance(world, 0.08)) {
      fireEnemyProjectile(world, boss.x, boss.y, Math.PI / 2, 120, 16, 6, "#ffb34f");
    }
  } else {
    boss.x += (world.width / 2 - boss.x) * seconds * 0.6;
    boss.y += (105 - boss.y) * seconds * 0.6;
  }
  if (world.elapsedMs >= boss.abilityCooldownUntilMs) {
    const direction = normalized(
      world.player.x - boss.x,
      world.player.y - boss.y,
    );
    boss.vx = direction.x * (430 + boss.phase * 85);
    boss.vy = direction.y * (430 + boss.phase * 85);
    boss.dashUntilMs = world.elapsedMs + 620;
    boss.abilityCooldownUntilMs = world.elapsedMs + Math.max(1_500, 3_200 - boss.phase * 350);
    addEffect(world, "dash", boss.x, boss.y, boss.radius * 1.7, "#ffb34f", 500);
    emit(world, { type: "sfx", id: "WARN" });
  }
  if (world.elapsedMs >= boss.fireCooldownUntilMs) {
    fireRadialBurst(world, boss.x, boss.y, 5 + boss.phase * 2, 190, 20, boss.rotation);
    boss.fireCooldownUntilMs = world.elapsedMs + 1_300;
  }
  if (boss.phase >= 2 && world.elapsedMs >= boss.summonCooldownUntilMs) {
    summonForBoss(world, boss.phase >= 3 ? "comet" : "debris", boss, boss.phase + 1);
    boss.summonCooldownUntilMs = world.elapsedMs + 4_200;
  }
}

function updateDreadnoughtBoss(world: GameWorld, boss: BossRuntime) {
  boss.x = world.width / 2 + Math.sin(boss.ageMs / 1_100) * 240;
  boss.y = 92 + Math.sin(boss.ageMs / 730) * 24;
  if (world.elapsedMs >= boss.fireCooldownUntilMs) {
    const volleys = boss.phase >= 3 ? [-0.24, -0.12, 0, 0.12, 0.24] : [-0.1, 0, 0.1];
    for (const spread of volleys) {
      fireAimedEnemyProjectile(
        world,
        boss.x,
        boss.y + 25,
        225 + boss.phase * 20,
        22 + boss.phase * 4,
        spread,
      );
    }
    boss.fireCooldownUntilMs = world.elapsedMs + Math.max(520, 1_180 - boss.phase * 120);
  }
  if (world.elapsedMs >= boss.summonCooldownUntilMs) {
    const archetype: EnemyArchetypeId =
      boss.phase >= 3 ? "support-drone" : boss.phase >= 2 ? "mine" : "gunner-drone";
    summonForBoss(world, archetype, boss, boss.phase >= 3 ? 2 : 1);
    boss.summonCooldownUntilMs = world.elapsedMs + Math.max(3_000, 5_600 - boss.phase * 500);
  }
  if (boss.phase >= 3 && world.elapsedMs >= boss.abilityCooldownUntilMs) {
    fireRadialBurst(world, boss.x, boss.y, 10 + boss.phase * 2, 205, 24, boss.rotation);
    if (boss.phase >= 4) {
      boss.x = randomRange(world, boss.radius + 20, world.width - boss.radius - 20);
      addEffect(world, "dash", boss.x, boss.y, boss.radius * 2, "#c58cff", 520);
    }
    boss.abilityCooldownUntilMs = world.elapsedMs + 2_500;
  }
}

function updateBoss(world: GameWorld, boss: BossRuntime, deltaMs: number) {
  if (world.boss !== boss) return;
  const hostileTimeScale = activePower(world, "time") ? 0.46 : 1;
  const scaledMs = deltaMs * hostileTimeScale;
  const seconds = scaledMs / 1_000;
  boss.ageMs += scaledMs;
  boss.rotation += seconds * (0.5 + boss.phase * 0.18);
  syncBossPhase(world, boss);
  if (boss.y < 92) boss.y = Math.min(92, boss.y + boss.vy * seconds);
  if (world.elapsedMs < boss.stunnedUntilMs) return;

  if (boss.bossId === "sentinel-array") {
    updateSentinelBoss(world, boss);
  } else if (boss.bossId === "comet-leviathan") {
    updateLeviathanBoss(world, boss, seconds);
  } else {
    updateDreadnoughtBoss(world, boss);
  }
}

function spawnPlannedEntities(world: GameWorld) {
  while (
    world.spawnCursor < world.wavePlan.spawns.length &&
    (world.wavePlan.spawns[world.spawnCursor]?.spawnAtMs ?? Number.POSITIVE_INFINITY) <=
      world.waveElapsedMs
  ) {
    const planned = world.wavePlan.spawns[world.spawnCursor];
    world.spawnCursor++;
    if (!planned || world.enemies.length >= MAX_ENEMIES) continue;
    const config = ENEMY_BALANCE[planned.archetype];
    const laneWidth = world.width / 7;
    spawnEnemy(world, planned.archetype, {
      x: laneWidth * (planned.lane + 0.5),
      y: -config.radius - 12,
      elite: planned.elite,
    });
  }

  const bossPlan = world.wavePlan.boss;
  if (
    bossPlan &&
    !world.bossSpawned &&
    world.waveElapsedMs >= bossPlan.spawnAtMs
  ) {
    const difficultyMultiplier =
      DIFFICULTY_BALANCE[world.difficulty].enemyHealthMultiplier;
    spawnBoss(
      world,
      bossPlan.boss,
      bossPlan.healthMultiplier / difficultyMultiplier,
    );
  }
}

function completeCurrentSector(world: GameWorld) {
  const sector = currentSectorMetric(world);
  if (sector.completed) return;
  sector.completed = true;
  if (sector.livesLost === 0) world.metrics.flawlessSectors++;
}

function clearCombatForRest(world: GameWorld) {
  world.enemies = [];
  world.enemyProjectiles = [];
  completeCurrentSector(world);
  world.player.shield = Math.min(
    world.player.maxShield,
    world.player.shield + world.player.maxShield * 0.24,
  );
  world.player.energy = Math.min(world.player.maxEnergy, world.player.energy + 22);
  emit(world, { type: "toast", id: "sector-clear", value: world.wave });
}

function applySectorHazard(world: GameWorld) {
  if (world.wavePhase !== "combat" || world.elapsedMs < world.hazardCooldownUntilMs) {
    return;
  }

  if (world.sector === "ion-storm") {
    world.player.energy = Math.max(0, world.player.energy - 12);
    addEffect(world, "emp", world.width / 2, world.height / 2, 360, "#9aff6b", 520);
    world.hazardCooldownUntilMs = world.elapsedMs + 4_200;
  } else if (world.sector === "ship-graveyard") {
    if (world.enemies.length < MAX_ENEMIES) spawnEnemy(world, "mine");
    world.hazardCooldownUntilMs = world.elapsedMs + 5_000;
  } else if (world.sector === "solar") {
    const x = randomRange(world, 40, world.width - 40);
    addEffect(world, "spawn", x, 0, 42, "#ffb34f", 650);
    for (const offset of [-20, 0, 20]) {
      fireEnemyProjectile(world, x + offset, -10, Math.PI / 2, 330, 24, 7, "#ffb34f");
    }
    world.hazardCooldownUntilMs = world.elapsedMs + 4_600;
  } else if (world.sector === "meteor-belt") {
    if (world.enemies.length < MAX_ENEMIES) {
      spawnEnemy(world, "debris", { speedMultiplier: 1.2 });
    }
    world.hazardCooldownUntilMs = world.elapsedMs + 3_700;
  } else {
    world.hazardCooldownUntilMs = world.elapsedMs + 5_500;
  }
}

function offerUpgrade(world: GameWorld) {
  const choices = selectUpgradeChoices({
    seed: world.seed,
    wave: world.wave,
    mode: world.mode,
    owned: world.upgradeStacks,
  });
  if (choices.length === 0) {
    advanceWave(world);
    return;
  }
  world.status = "upgrade";
  world.upgradeChoices = choices;
  emit(world, { type: "upgrade", action: "offered", choices: [...choices] });
}

export function advanceWave(world: GameWorld) {
  if (world.result) return false;
  completeCurrentSector(world);
  const finiteCount = MODE_BALANCE[world.mode].finiteWaveCount;
  if (finiteCount !== null && world.wave >= finiteCount) {
    finishWorld(world, "victory");
    return false;
  }
  world.wave++;
  world.wavePlan = createWavePlan({
    mode: world.mode,
    difficulty: world.difficulty,
    wave: world.wave,
    seed: world.seed,
  });
  world.sector = world.wavePlan.sector;
  world.waveElapsedMs = 0;
  world.wavePhase = "telegraph";
  world.spawnCursor = 0;
  world.bossSpawned = false;
  world.boss = null;
  world.enemies = [];
  world.enemyProjectiles = [];
  world.damageTakenThisWave = false;
  world.upgradeChoices = [];
  world.status = "playing";
  world.hazardCooldownUntilMs = 0;
  currentSectorMetric(world);
  const nanites = upgradeCount(world, "repair-nanites");
  if (nanites > 0 && world.wave % Math.max(2, 4 - nanites) === 0) {
    world.player.lives = Math.min(world.player.maxLives, world.player.lives + 1);
  }
  emit(world, {
    type: "wave",
    action: "start",
    wave: world.wave,
    phase: "telegraph",
    sector: world.sector,
  });
  return true;
}

export function selectUpgrade(world: GameWorld, id: UpgradeId) {
  if (
    world.status !== "upgrade" ||
    world.result ||
    !world.upgradeChoices.includes(id)
  ) {
    return false;
  }
  world.upgradeStacks = addUpgradeStack(world.upgradeStacks, id);
  if (id === "reinforced-shield") {
    world.player.maxShield += 25;
    world.player.shield = world.player.maxShield;
  } else if (id === "repair-nanites") {
    world.player.lives = Math.min(world.player.maxLives, world.player.lives + 1);
  }
  emit(world, {
    type: "upgrade",
    action: "selected",
    choices: [...world.upgradeChoices],
    selected: id,
  });
  return advanceWave(world);
}

function updateWave(world: GameWorld, deltaMs: number) {
  const previousPhase = world.wavePhase;
  world.waveElapsedMs += deltaMs;
  const rest = world.wavePlan.phases.find((phase) => phase.kind === "rest");
  if (
    rest &&
    world.boss &&
    world.waveElapsedMs >= rest.startsAtMs
  ) {
    world.waveElapsedMs = Math.max(0, rest.startsAtMs - 0.001);
  }
  world.wavePhase = wavePhaseFor(world);

  if (world.wavePhase !== previousPhase) {
    emit(world, {
      type: "wave",
      action: "phase",
      wave: world.wave,
      phase: world.wavePhase,
      sector: world.sector,
    });
    if (world.wavePhase === "combat") {
      emit(world, { type: "sfx", id: "WARN" });
    } else if (world.wavePhase === "rest") {
      clearCombatForRest(world);
      emit(world, {
        type: "wave",
        action: "complete",
        wave: world.wave,
        phase: "rest",
        sector: world.sector,
      });
    }
  }

  if (world.wavePhase === "combat") spawnPlannedEntities(world);
  applySectorHazard(world);
  if (world.waveElapsedMs < world.wavePlan.totalDurationMs) return;

  if (world.mode === "expedition" && isFinalModeWave(world.mode, world.wave)) {
    finishWorld(world, "victory");
  } else if (MODE_BALANCE[world.mode].allowsUpgradeChoices) {
    offerUpgrade(world);
  } else {
    advanceWave(world);
  }
}

function updatePlayerProjectiles(world: GameWorld, deltaMs: number) {
  const seconds = deltaMs / 1_000;
  for (const projectile of world.playerProjectiles) {
    if (projectile.kind === "missile") {
      const target =
        world.enemies.find((enemy) => enemy.id === projectile.targetId) ??
        world.boss;
      if (target) {
        const desired = aimedVelocity(
          projectile.x,
          projectile.y,
          target.x,
          target.y,
          390,
        );
        projectile.vx += (desired.x - projectile.vx) * Math.min(1, seconds * 4.5);
        projectile.vy += (desired.y - projectile.vy) * Math.min(1, seconds * 4.5);
      } else {
        const next = nearestEnemy(world, projectile.x, projectile.y);
        projectile.targetId = next?.id ?? world.boss?.id ?? null;
      }
    }
    projectile.x += projectile.vx * seconds;
    projectile.y += projectile.vy * seconds;
  }
  world.playerProjectiles = world.playerProjectiles.filter(
    (shot) =>
      shot.expiresAtMs > world.elapsedMs &&
      shot.x > -80 &&
      shot.x < world.width + 80 &&
      shot.y > -100 &&
      shot.y < world.height + 100,
  );
}

function updateEnemyProjectiles(world: GameWorld, deltaMs: number) {
  const hostileTimeScale = activePower(world, "time") ? 0.46 : 1;
  const sectorSpeedMultiplier =
    world.sector === "nebula" ? 0.82 : world.sector === "dark" ? 1.12 : 1;
  const seconds =
    (deltaMs * hostileTimeScale * sectorSpeedMultiplier) / 1_000;
  for (const projectile of world.enemyProjectiles) {
    projectile.x += projectile.vx * seconds;
    projectile.y += projectile.vy * seconds;
  }
  world.enemyProjectiles = world.enemyProjectiles.filter(
    (shot) =>
      shot.expiresAtMs > world.elapsedMs &&
      shot.x > -80 &&
      shot.x < world.width + 80 &&
      shot.y > -100 &&
      shot.y < world.height + 100,
  );
}

function projectileExplosion(
  world: GameWorld,
  projectile: ProjectileRuntime,
) {
  if (projectile.kind !== "missile") return;
  addEffect(world, "explosion", projectile.x, projectile.y, 46, "#ffb34f", 420);
  for (const enemy of [...world.enemies]) {
    if (
      !hasHitTarget(projectile, enemy.id) &&
      magnitude(enemy.x - projectile.x, enemy.y - projectile.y) <= 58
    ) {
      rememberHitTarget(projectile, enemy.id);
      damageEnemy(world, enemy, projectile.damage * 0.55, projectile);
    }
  }
  if (
    world.boss &&
    !hasHitTarget(projectile, world.boss.id) &&
    magnitude(world.boss.x - projectile.x, world.boss.y - projectile.y) <=
      world.boss.radius + 50
  ) {
    rememberHitTarget(projectile, world.boss.id);
    damageBoss(world, world.boss, projectile.damage * 0.4, projectile);
  }
}

function collidePlayerProjectiles(world: GameWorld) {
  const removed = new Set<ProjectileRuntime>();
  for (const projectile of [...world.playerProjectiles]) {
    for (const enemy of [...world.enemies]) {
      if (
        !removed.has(projectile) &&
        !hasHitTarget(projectile, enemy.id) &&
        circlesTouch(
          projectile.x,
          projectile.y,
          projectile.radius,
          enemy.x,
          enemy.y,
          enemy.radius,
        )
      ) {
        rememberHitTarget(projectile, enemy.id);
        damageEnemy(world, enemy, projectile.damage, projectile);
        projectile.pierce--;
        if (projectile.pierce < 0) {
          removed.add(projectile);
          projectileExplosion(world, projectile);
        }
      }
    }

    const boss = world.boss;
    if (
      boss &&
      !removed.has(projectile) &&
      !hasHitTarget(projectile, boss.id) &&
      circlesTouch(
        projectile.x,
        projectile.y,
        projectile.radius,
        boss.x,
        boss.y,
        boss.radius,
      )
    ) {
      rememberHitTarget(projectile, boss.id);
      damageBoss(world, boss, projectile.damage, projectile);
      projectile.pierce--;
      if (projectile.pierce < 0) {
        removed.add(projectile);
        projectileExplosion(world, projectile);
      }
    }
  }
  if (removed.size > 0) {
    world.playerProjectiles = world.playerProjectiles.filter(
      (shot) => !removed.has(shot),
    );
  }
}

function collideHostilesWithPlayer(world: GameWorld) {
  const removedShots = new Set<ProjectileRuntime>();
  for (const projectile of world.enemyProjectiles) {
    if (
      circlesTouch(
        projectile.x,
        projectile.y,
        projectile.radius,
        world.player.x,
        world.player.y,
        world.player.radius,
      )
    ) {
      removedShots.add(projectile);
      damagePlayer(world, projectile.damage);
    }
  }
  if (removedShots.size > 0) {
    world.enemyProjectiles = world.enemyProjectiles.filter(
      (shot) => !removedShots.has(shot),
    );
  }

  for (const enemy of [...world.enemies]) {
    if (
      circlesTouch(
        enemy.x,
        enemy.y,
        enemy.radius * 0.82,
        world.player.x,
        world.player.y,
        world.player.radius,
      )
    ) {
      damagePlayer(world, enemy.contactDamage);
      addEffect(world, "explosion", enemy.x, enemy.y, enemy.radius * 1.6, "#ff6b3d");
      removeEnemyWithoutReward(world, enemy);
    }
  }

  if (
    world.boss &&
    circlesTouch(
      world.boss.x,
      world.boss.y,
      world.boss.radius * 0.82,
      world.player.x,
      world.player.y,
      world.player.radius,
    )
  ) {
    damagePlayer(
      world,
      70 * DIFFICULTY_BALANCE[world.difficulty].enemyDamageMultiplier,
    );
  }
}

function updatePickups(world: GameWorld, deltaMs: number) {
  const seconds = deltaMs / 1_000;
  const magnetRange =
    activePower(world, "magnet") || upgradeCount(world, "magnet-array") > 0
      ? 290 + upgradeCount(world, "magnet-array") * 45
      : 74;
  const collected = new Set<PickupRuntime>();
  for (const pickup of world.pickups) {
    const distance = magnitude(
      world.player.x - pickup.x,
      world.player.y - pickup.y,
    );
    if (distance < magnetRange) {
      const direction = normalized(
        world.player.x - pickup.x,
        world.player.y - pickup.y,
      );
      const attraction = distance < 70 ? 620 : 300;
      pickup.vx += direction.x * attraction * seconds;
      pickup.vy += direction.y * attraction * seconds;
    }
    pickup.x += pickup.vx * seconds;
    pickup.y += pickup.vy * seconds;
    pickup.vx *= 0.985;
    pickup.vy *= 0.985;
    if (
      circlesTouch(
        pickup.x,
        pickup.y,
        pickup.radius,
        world.player.x,
        world.player.y,
        world.player.radius,
      )
    ) {
      collected.add(pickup);
      world.metrics.powerUpsCollected++;
      if (pickup.kind === "energy") {
        world.player.energy = Math.min(
          world.player.maxEnergy,
          world.player.energy + pickup.value,
        );
      } else if (pickup.powerUpId) {
        equipCollectedPowerUp(world, pickup.powerUpId);
      }
      addEffect(world, "pickup", pickup.x, pickup.y, 28, "#d7f55a", 360);
      emit(world, { type: "sfx", id: "POWER" });
    }
  }
  world.pickups = world.pickups.filter(
    (pickup) =>
      !collected.has(pickup) &&
      pickup.expiresAtMs > world.elapsedMs &&
      pickup.y < world.height + 50,
  );
}

function updateEffects(world: GameWorld, deltaMs: number) {
  world.effects = world.effects.filter(
    (effect) => effect.expiresAtMs > world.elapsedMs,
  );
  world.screenShake = Math.max(0, world.screenShake - deltaMs * 0.022);
}

function stepPhysicsSlice(
  world: GameWorld,
  input: GameWorldInput,
  deltaMs: number,
) {
  world.elapsedMs += deltaMs;
  const previousDurationMs = world.activeDurationMs;
  world.activeDurationMs = Math.min(
    MAX_RUN_DURATION_MS,
    world.activeDurationMs + deltaMs,
  );
  currentSectorMetric(world).durationMs +=
    world.activeDurationMs - previousDurationMs;
  updateWave(world, deltaMs);
  if (world.status !== "playing" || world.result) return;
  updatePlayer(world, input, deltaMs);
  for (const enemy of [...world.enemies]) updateEnemy(world, enemy, deltaMs);
  if (world.boss) updateBoss(world, world.boss, deltaMs);
  updatePlayerProjectiles(world, deltaMs);
  updateEnemyProjectiles(world, deltaMs);
  collidePlayerProjectiles(world);
  collideHostilesWithPlayer(world);
  updatePickups(world, deltaMs);
  updateEffects(world, deltaMs);
  if (world.activeDurationMs >= MAX_RUN_DURATION_MS) {
    finishWorld(world, "duration-limit");
  }
}

export function stepGameWorld(
  world: GameWorld,
  input: GameWorldInput,
  deltaMs: number,
): readonly GameEvent[] {
  world.events = [];
  if (world.result || world.status !== "playing") return world.events;
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return world.events;

  let remaining = Math.min(MAX_RUNTIME_DELTA_MS, deltaMs);
  while (remaining > 0 && world.status === "playing" && !world.result) {
    const slice = Math.min(PHYSICS_SLICE_MS, remaining);
    stepPhysicsSlice(world, input, slice);
    remaining -= slice;
  }
  return [...world.events];
}
