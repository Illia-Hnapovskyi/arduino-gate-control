import {
  MAX_PLANNABLE_WAVES,
  MAX_RUN_DURATION_MS,
  POWER_UP_BALANCE,
  UPGRADE_BALANCE,
} from "./balance.ts";
import {
  DIFFICULTY_IDS,
  GAME_MODE_IDS,
  POWER_UP_IDS,
  type DifficultyId,
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
} from "./types.ts";
import { createWavePlan, getSectorIdForWave } from "./waves.ts";

export const RUN_SNAPSHOT_STORAGE_KEY =
  "arduino-gate-space-defender-run:v2";
export const RUN_SNAPSHOT_VERSION = 2;
export const RUN_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type RunCheckpointPhase = "wave-rest" | "upgrade";

export type ResumablePlayerTimers = {
  invulnerableUntilMs: number;
  fireCooldownUntilMs: number;
  droneCooldownUntilMs: number;
  missileCooldownUntilMs: number;
};

export type ResumableRunState = {
  runId: string;
  mode: GameModeId;
  difficulty: DifficultyId;
  seed: number;
  rngState: number;
  nextEntityId: number;
  wave: number;
  sector: SectorId;
  phase: RunCheckpointPhase;
  activeDurationMs: number;
  elapsedMs: number;
  waveElapsedMs: number;
  score: number;
  lives: number;
  shield: number;
  energy: number;
  controller: RunController;
  controllerSources: RunControllerSource[];
  upgradeStacks: UpgradeStacks;
  upgradeChoices: UpgradeId[];
  equippedPowerUp: PowerUpId;
  powerStates: Partial<Record<PowerUpId, PowerUpRuntimeState>>;
  playerTimers: ResumablePlayerTimers;
  metrics: RunMetrics;
};

export type RunSnapshot = {
  version: typeof RUN_SNAPSHOT_VERSION;
  createdAtMs: number;
  savedAtMs: number;
  profileOwnerId: string | null;
  run: ResumableRunState;
};

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u;
const PROFILE_OWNER_ID_PATTERN = /^profile_[0-9a-f]{16}$/u;
const CONTROLLER_SOURCES: readonly RunControllerSource[] = [
  "arduino",
  "keyboard",
  "touch",
];
const CONTROLLERS: readonly RunController[] = [
  "arduino",
  "keyboard",
  "touch",
  "mixed",
];
const CHECKPOINT_PHASES: readonly RunCheckpointPhase[] = [
  "wave-rest",
  "upgrade",
];
const LEGACY_POWER_UP_ALIASES: Readonly<Record<string, PowerUpId>> = {
  "triple-shot": "spread",
  "time-slow": "time",
  "escort-drone": "drone",
  "repulsor-wave": "pulse",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isFiniteInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isMode(value: unknown): value is GameModeId {
  return typeof value === "string" && GAME_MODE_IDS.includes(value as GameModeId);
}

function isDifficulty(value: unknown): value is DifficultyId {
  return (
    typeof value === "string" &&
    DIFFICULTY_IDS.includes(value as DifficultyId)
  );
}

function isPowerUp(value: unknown): value is PowerUpId {
  return typeof value === "string" && POWER_UP_IDS.includes(value as PowerUpId);
}

function normalizePowerUp(value: unknown): PowerUpId | null {
  if (isPowerUp(value)) return value;
  return typeof value === "string"
    ? (LEGACY_POWER_UP_ALIASES[value] ?? null)
    : null;
}

function sanitizeUpgradeStacks(value: unknown): UpgradeStacks {
  if (!isRecord(value)) return {};
  const result: UpgradeStacks = {};
  for (const id of Object.keys(UPGRADE_BALANCE) as UpgradeId[]) {
    const stacks = value[id];
    if (
      typeof stacks === "number" &&
      Number.isSafeInteger(stacks) &&
      stacks > 0
    ) {
      result[id] = Math.min(stacks, UPGRADE_BALANCE[id].maxStacks);
    }
  }
  return result;
}

function upgradesFromLegacyList(value: unknown): UpgradeStacks {
  if (!Array.isArray(value)) return {};
  const result: UpgradeStacks = {};
  for (const candidate of value) {
    if (
      typeof candidate !== "string" ||
      !(candidate in UPGRADE_BALANCE)
    ) {
      continue;
    }
    const id = candidate as UpgradeId;
    const current = result[id] ?? 0;
    result[id] = Math.min(current + 1, UPGRADE_BALANCE[id].maxStacks);
  }
  return result;
}

function sanitizeUpgradeChoices(value: unknown, mode: GameModeId) {
  if (!Array.isArray(value)) return [];
  const choices: UpgradeId[] = [];
  for (const candidate of value) {
    if (
      typeof candidate !== "string" ||
      !(candidate in UPGRADE_BALANCE)
    ) {
      continue;
    }
    const id = candidate as UpgradeId;
    if (
      (UPGRADE_BALANCE[id].compatibleModes as readonly GameModeId[]).includes(
        mode,
      ) &&
      !choices.includes(id)
    ) {
      choices.push(id);
    }
    if (choices.length === 3) break;
  }
  return choices;
}

function sanitizeControllerSources(
  value: unknown,
  controller: RunController,
): RunControllerSource[] {
  if (Array.isArray(value)) {
    const sources = value.filter(
      (candidate): candidate is RunControllerSource =>
        typeof candidate === "string" &&
        CONTROLLER_SOURCES.includes(candidate as RunControllerSource),
    );
    const unique = [...new Set(sources)].sort();
    if (controller === "mixed") {
      return unique.length >= 2 ? unique : ["keyboard", "touch"];
    }
    return [controller as RunControllerSource];
  }
  return controller === "mixed"
    ? (["keyboard", "touch"] as RunControllerSource[])
    : [controller as RunControllerSource];
}

function sanitizeCooldowns(
  value: unknown,
): Partial<Record<PowerUpId, number>> {
  if (!isRecord(value)) return {};
  const result: Partial<Record<PowerUpId, number>> = {};
  for (const id of POWER_UP_IDS) {
    const remaining = value[id];
    if (
      typeof remaining === "number" &&
      Number.isSafeInteger(remaining) &&
      remaining > 0
    ) {
      result[id] = Math.min(
        remaining,
        POWER_UP_BALANCE[id].cooldownMs,
      );
    }
  }
  for (const [legacyId, canonicalId] of Object.entries(
    LEGACY_POWER_UP_ALIASES,
  )) {
    const remaining = value[legacyId];
    if (
      result[canonicalId] === undefined &&
      typeof remaining === "number" &&
      Number.isSafeInteger(remaining) &&
      remaining > 0
    ) {
      result[canonicalId] = Math.min(
        remaining,
        POWER_UP_BALANCE[canonicalId].cooldownMs,
      );
    }
  }
  return result;
}

function sanitizePowerStates(
  value: unknown,
  legacyCooldowns: unknown,
  elapsedMs: number,
): Partial<Record<PowerUpId, PowerUpRuntimeState>> {
  const result: Partial<Record<PowerUpId, PowerUpRuntimeState>> = {};
  if (isRecord(value)) {
    for (const id of POWER_UP_IDS) {
      const candidate = value[id];
      if (!isRecord(candidate)) continue;
      const activatedAtMs = candidate.activatedAtMs;
      const activeUntilMs = candidate.activeUntilMs;
      const cooldownUntilMs = candidate.cooldownUntilMs;
      const maximumCooldownUntilMs =
        elapsedMs + POWER_UP_BALANCE[id].cooldownMs;
      if (
        candidate.id !== id ||
        !isFiniteInRange(activatedAtMs, 0, elapsedMs) ||
        !isFiniteInRange(
          activeUntilMs,
          activatedAtMs,
          elapsedMs + POWER_UP_BALANCE[id].durationMs,
        ) ||
        !isFiniteInRange(
          cooldownUntilMs,
          activeUntilMs,
          maximumCooldownUntilMs,
        )
      ) {
        continue;
      }
      result[id] = {
        id,
        activatedAtMs,
        activeUntilMs,
        cooldownUntilMs,
      };
    }
  }

  if (Object.keys(result).length > 0) return result;
  for (const [id, remaining] of Object.entries(
    sanitizeCooldowns(legacyCooldowns),
  )) {
    if (!remaining) continue;
    const powerId = id as PowerUpId;
    result[powerId] = {
      id: powerId,
      activatedAtMs: elapsedMs,
      activeUntilMs: elapsedMs,
      cooldownUntilMs: elapsedMs + remaining,
    };
  }
  return result;
}

function sanitizePlayerTimers(
  value: unknown,
  elapsedMs: number,
): ResumablePlayerTimers {
  const source = isRecord(value) ? value : {};
  const sanitizeTimer = (candidate: unknown) =>
    isFiniteInRange(candidate, 0, MAX_RUN_DURATION_MS + 120_000)
      ? candidate
      : elapsedMs;
  return {
    invulnerableUntilMs: sanitizeTimer(source.invulnerableUntilMs),
    fireCooldownUntilMs: sanitizeTimer(source.fireCooldownUntilMs),
    droneCooldownUntilMs: sanitizeTimer(source.droneCooldownUntilMs),
    missileCooldownUntilMs: sanitizeTimer(source.missileCooldownUntilMs),
  };
}

function sanitizePowerUps(value: unknown): PowerUpId[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map(normalizePowerUp)
    .filter((id): id is PowerUpId => id !== null);
  return [...new Set(normalized)].sort();
}

function sanitizePowerUpCounts(
  value: unknown,
): Partial<Record<PowerUpId, number>> {
  if (!isRecord(value)) return {};
  const result: Partial<Record<PowerUpId, number>> = {};
  for (const id of POWER_UP_IDS) {
    const count = value[id];
    if (typeof count === "number" && Number.isSafeInteger(count) && count > 0) {
      result[id] = Math.min(count, 1_000_000);
    }
  }
  return result;
}

function sanitizeMetricCount(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  return isSafeIntegerInRange(value, 0, maximum) ? value : 0;
}

function sanitizeSectorMetrics(
  value: unknown,
  mode: GameModeId,
): RunSectorMetric[] {
  if (!Array.isArray(value)) return [];
  const result: RunSectorMetric[] = [];
  const seenWaves = new Set<number>();
  for (const candidate of value.slice(0, MAX_PLANNABLE_WAVES)) {
    if (!isRecord(candidate)) continue;
    const wave = candidate.wave;
    const durationMs = candidate.durationMs;
    const livesLost = candidate.livesLost;
    if (
      !isSafeIntegerInRange(wave, 1, MAX_PLANNABLE_WAVES) ||
      seenWaves.has(wave) ||
      !isFiniteInRange(durationMs, 0, MAX_RUN_DURATION_MS) ||
      !isSafeIntegerInRange(livesLost, 0, 1_000_000) ||
      typeof candidate.completed !== "boolean"
    ) {
      continue;
    }
    let sectorId: SectorId;
    try {
      sectorId = getSectorIdForWave(mode, wave);
    } catch {
      continue;
    }
    if (candidate.sectorId !== sectorId) continue;
    seenWaves.add(wave);
    result.push({
      wave,
      sectorId,
      durationMs,
      completed: candidate.completed,
      livesLost,
    });
  }
  return result.sort((left, right) => left.wave - right.wave);
}

function sanitizeMetrics(value: unknown, mode: GameModeId): RunMetrics {
  const source = isRecord(value) ? value : {};
  const shotsFired = sanitizeMetricCount(source.shotsFired);
  const sectors = sanitizeSectorMetrics(source.sectors, mode);
  return {
    enemiesDestroyed: sanitizeMetricCount(source.enemiesDestroyed),
    bossesDefeated: sanitizeMetricCount(source.bossesDefeated),
    shotsFired,
    shotsHit: Math.min(shotsFired, sanitizeMetricCount(source.shotsHit)),
    longestCombo: sanitizeMetricCount(source.longestCombo),
    powerUpsCollected: sanitizeMetricCount(source.powerUpsCollected),
    powerUpsUsed: sanitizePowerUps(source.powerUpsUsed),
    powerUpsCollectedById: sanitizePowerUpCounts(source.powerUpsCollectedById),
    powerUpsActivatedById: sanitizePowerUpCounts(source.powerUpsActivatedById),
    flawlessSectors: sanitizeMetricCount(source.flawlessSectors),
    livesLost: sanitizeMetricCount(
      source.livesLost,
      1_000_000,
    ),
    sectors,
  };
}

function sanitizeRun(
  source: Record<string, unknown>,
): ResumableRunState | null {
  const runId = source.runId;
  const mode = source.mode;
  const difficulty = source.difficulty;
  const seed = source.seed;
  const rngState = source.rngState ?? seed;
  const nextEntityId = source.nextEntityId ?? 0;
  const wave = source.wave;
  const phase = source.phase;
  const activeDurationMs = source.activeDurationMs;
  const elapsedMs = source.elapsedMs ?? activeDurationMs;
  const score = source.score;
  const lives = source.lives;
  const controller = source.controller;
  const equippedPowerUp = normalizePowerUp(source.equippedPowerUp);

  if (
    typeof runId !== "string" ||
    !RUN_ID_PATTERN.test(runId) ||
    !isMode(mode) ||
    !isDifficulty(difficulty) ||
    !isSafeIntegerInRange(seed, 0, 0xffff_ffff) ||
    !isSafeIntegerInRange(rngState, 0, 0xffff_ffff) ||
    !isSafeIntegerInRange(nextEntityId, 0, 10_000_000) ||
    !isSafeIntegerInRange(wave, 1, MAX_PLANNABLE_WAVES) ||
    typeof phase !== "string" ||
    !CHECKPOINT_PHASES.includes(phase as RunCheckpointPhase) ||
    !isFiniteInRange(activeDurationMs, 0, MAX_RUN_DURATION_MS) ||
    !isFiniteInRange(elapsedMs, activeDurationMs, MAX_RUN_DURATION_MS) ||
    !isSafeIntegerInRange(score, 0, 100_000_000) ||
    score % 10 !== 0 ||
    !isSafeIntegerInRange(lives, 1, 3) ||
    typeof controller !== "string" ||
    !CONTROLLERS.includes(controller as RunController) ||
    equippedPowerUp === null
  ) {
    return null;
  }

  let sector: SectorId;
  try {
    sector = getSectorIdForWave(mode, wave);
  } catch {
    return null;
  }

  let wavePlan: ReturnType<typeof createWavePlan>;
  try {
    wavePlan = createWavePlan({ mode, difficulty, wave, seed });
  } catch {
    return null;
  }
  const waveElapsedMs = source.waveElapsedMs ?? wavePlan.totalDurationMs;
  if (
    !isFiniteInRange(
      waveElapsedMs,
      0,
      wavePlan.totalDurationMs + 250,
    )
  ) {
    return null;
  }

  const upgradeStacks = sanitizeUpgradeStacks(source.upgradeStacks);
  const maximumShield =
    100 + (upgradeStacks["reinforced-shield"] ?? 0) * 25;
  const shield = source.shield ?? maximumShield;
  const energy = source.energy ?? 100;
  if (
    !isFiniteInRange(shield, 0, maximumShield) ||
    !isFiniteInRange(energy, 0, 100)
  ) {
    return null;
  }
  const normalizedController = controller as RunController;

  return {
    runId,
    mode,
    difficulty,
    seed,
    rngState,
    nextEntityId,
    wave,
    sector,
    phase: phase as RunCheckpointPhase,
    activeDurationMs,
    elapsedMs,
    waveElapsedMs,
    score,
    lives,
    shield,
    energy,
    controller: normalizedController,
    controllerSources: sanitizeControllerSources(
      source.controllerSources,
      normalizedController,
    ),
    upgradeStacks,
    upgradeChoices: sanitizeUpgradeChoices(source.upgradeChoices, mode),
    equippedPowerUp,
    powerStates: sanitizePowerStates(
      source.powerStates,
      source.powerCooldownRemainingMs,
      elapsedMs,
    ),
    playerTimers: sanitizePlayerTimers(source.playerTimers, elapsedMs),
    metrics: sanitizeMetrics(source.metrics, mode),
  };
}

function migrateVersionOne(source: Record<string, unknown>): RunSnapshot | null {
  const savedAtMs = source.savedAtMs;
  const createdAtMs = source.createdAtMs ?? savedAtMs;
  if (
    !isSafeIntegerInRange(savedAtMs, 0, Number.MAX_SAFE_INTEGER) ||
    !isSafeIntegerInRange(createdAtMs, 0, savedAtMs)
  ) {
    return null;
  }

  const migratedRun = sanitizeRun({
    runId: source.runId,
    mode: source.mode,
    difficulty: source.difficulty,
    seed: source.seed,
    wave: source.currentWave,
    phase: "upgrade",
    activeDurationMs: source.durationMs,
    score: source.score,
    lives: source.lives,
    controller: source.controller ?? "keyboard",
    upgradeStacks: upgradesFromLegacyList(source.upgrades),
    equippedPowerUp: source.equippedPowerUp ?? "emp",
    powerCooldownRemainingMs: {},
    metrics: source.metrics,
  });
  if (!migratedRun) return null;
  return {
    version: RUN_SNAPSHOT_VERSION,
    createdAtMs,
    savedAtMs,
    profileOwnerId: null,
    run: migratedRun,
  };
}

export function sanitizeRunSnapshot(value: unknown): RunSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.version === 1) return migrateVersionOne(value);
  if (value.version !== RUN_SNAPSHOT_VERSION) return null;

  const createdAtMs = value.createdAtMs;
  const savedAtMs = value.savedAtMs;
  const profileOwnerId = value.profileOwnerId ?? null;
  if (
    !isSafeIntegerInRange(savedAtMs, 0, Number.MAX_SAFE_INTEGER) ||
    !isSafeIntegerInRange(createdAtMs, 0, savedAtMs) ||
    (profileOwnerId !== null &&
      (typeof profileOwnerId !== "string" ||
        !PROFILE_OWNER_ID_PATTERN.test(profileOwnerId))) ||
    !isRecord(value.run)
  ) {
    return null;
  }
  const run = sanitizeRun(value.run);
  if (!run) return null;
  return {
    version: RUN_SNAPSHOT_VERSION,
    createdAtMs,
    savedAtMs,
    profileOwnerId,
    run,
  };
}

export function serializeRunSnapshot(snapshot: RunSnapshot) {
  const sanitized = sanitizeRunSnapshot(snapshot);
  if (!sanitized) throw new TypeError("Cannot serialize an invalid run snapshot.");
  return JSON.stringify(sanitized);
}

export function parseRunSnapshot(
  serialized: string | null,
  nowMs: number,
  maximumAgeMs = RUN_SNAPSHOT_MAX_AGE_MS,
): RunSnapshot | null {
  if (
    serialized === null ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(maximumAgeMs) ||
    maximumAgeMs < 0
  ) {
    return null;
  }
  try {
    const snapshot = sanitizeRunSnapshot(JSON.parse(serialized) as unknown);
    if (!snapshot) return null;
    if (snapshot.savedAtMs > nowMs + 5 * 60 * 1000) return null;
    if (nowMs - snapshot.savedAtMs > maximumAgeMs) return null;
    return snapshot;
  } catch {
    return null;
  }
}

export function canResumeRun(snapshot: RunSnapshot) {
  return snapshot.run.lives > 0 && snapshot.run.activeDurationMs < MAX_RUN_DURATION_MS;
}

export function getRemainingRunDurationMs(snapshot: RunSnapshot) {
  return Math.max(0, MAX_RUN_DURATION_MS - snapshot.run.activeDurationMs);
}

export function saveRunSnapshot(storage: StorageLike, snapshot: RunSnapshot) {
  try {
    storage.setItem(RUN_SNAPSHOT_STORAGE_KEY, serializeRunSnapshot(snapshot));
    return true;
  } catch {
    return false;
  }
}

export function loadRunSnapshot(
  storage: StorageLike,
  nowMs: number,
): RunSnapshot | null {
  try {
    return parseRunSnapshot(storage.getItem(RUN_SNAPSHOT_STORAGE_KEY), nowMs);
  } catch {
    return null;
  }
}

export function clearRunSnapshot(storage: StorageLike) {
  try {
    storage.removeItem(RUN_SNAPSHOT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
