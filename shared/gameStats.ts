export const GAME_STATS_API_PATH = "/api/stats";

export const GAME_STATS_LANGUAGES = ["uk", "de", "en"] as const;

export const GAME_MODE_IDS = ["expedition", "survival", "classic"] as const;
export const GAME_DIFFICULTY_IDS = ["cadet", "pilot", "ace"] as const;
export const GAME_SECTOR_IDS = [
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
export const GAME_POWER_IDS = [
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

export const GAME_ACHIEVEMENTS = [
  { id: "first_run", target: 1, rarity: "common", icon: "launch" },
  { id: "first_enemy", target: 1, rarity: "common", icon: "target" },
  { id: "first_boss", target: 1, rarity: "rare", icon: "boss" },
  { id: "survivor_5m", target: 300_000, rarity: "rare", icon: "timer" },
  { id: "flawless_sector", target: 1, rarity: "rare", icon: "shield" },
  { id: "combo_25", target: 25, rarity: "rare", icon: "combo" },
  { id: "score_10000", target: 10_000, rarity: "epic", icon: "star" },
  { id: "sharpshooter", target: 700, rarity: "rare", icon: "crosshair" },
  { id: "arduino_pilot", target: 1, rarity: "rare", icon: "controller" },
  {
    id: "power_explorer",
    target: GAME_POWER_IDS.length,
    rarity: "legendary",
    icon: "power",
  },
  { id: "max_level", target: 9, rarity: "epic", icon: "level" },
  { id: "veteran_10", target: 10, rarity: "epic", icon: "medal" },
] as const;

export const MAX_GAME_SYNC_EVENTS = 5;

export type GameStatsLanguage = (typeof GAME_STATS_LANGUAGES)[number];
export type GameModeId = (typeof GAME_MODE_IDS)[number];
export type GameDifficultyId = (typeof GAME_DIFFICULTY_IDS)[number];
export type GameSectorId = (typeof GAME_SECTOR_IDS)[number];
export type GamePowerId = (typeof GAME_POWER_IDS)[number];
export type GameAchievementId = (typeof GAME_ACHIEVEMENTS)[number]["id"];
export type GameAchievementRarity =
  (typeof GAME_ACHIEVEMENTS)[number]["rarity"];

const GAME_SECTOR_CYCLES = {
  expedition: GAME_SECTOR_IDS,
  survival: GAME_SECTOR_IDS,
  classic: ["starfield"],
} as const satisfies Record<GameModeId, readonly GameSectorId[]>;

export function getGameSectorForWave(
  mode: GameModeId,
  wave: number,
): GameSectorId {
  if (!Number.isSafeInteger(wave) || wave < 1) {
    throw new RangeError("Wave must be a positive safe integer.");
  }
  const cycle = GAME_SECTOR_CYCLES[mode];
  return cycle[(wave - 1) % cycle.length] as GameSectorId;
}

export type GameInputKind =
  | "unknown"
  | "keyboard"
  | "touch"
  | "arduino"
  | "mixed";

export type PlayerStats = {
  nickname: string;
  gamesPlayed: number;
  totalScore: number;
  highScore: number;
  highestLevel: number;
  totalDurationMs: number;
  updatedAt: string;
};

export type LeaderboardEntry = PlayerStats & {
  rank: number;
};

export type CreateStatsRequest = {
  action: "create";
  accessCode: string;
  nickname?: string;
  language: GameStatsLanguage;
};

export type ConnectStatsRequest = {
  action: "connect";
  accessCode: string;
};

export type RenameStatsRequest = {
  action: "rename";
  accessCode: string;
  nickname: string;
};

export type RecordStatsRequest = {
  action: "record";
  accessCode: string;
  runId: string;
  score: number;
  level: number;
  durationMs: number;
};

export type GameRunPowerSummary = {
  powerId: GamePowerId;
  collectedCount: number;
  activatedCount: number;
};

export type GameRunSectorSummary = {
  sectorIndex: number;
  sectorId: GameSectorId;
  completed: boolean;
  livesLost: number;
  durationMs: number;
};

export type GameRunSummaryInput = ValidatedRun & {
  modeId?: GameModeId;
  difficultyId?: GameDifficultyId;
  highestWave?: number;
  finalSectorId?: GameSectorId;
  enemiesDestroyed?: number;
  bossesDefeated?: number;
  shotsFired?: number;
  shotsHit?: number;
  longestCombo?: number;
  powerupsCollected?: number;
  livesLost?: number;
  won?: boolean;
  inputKind?: GameInputKind;
  endedReason?: string;
  clientEndedAt?: string | null;
  powers?: GameRunPowerSummary[];
  sectors?: GameRunSectorSummary[];
};

export type ValidatedRunSummary = ValidatedRun & {
  modeId: GameModeId;
  difficultyId: GameDifficultyId;
  highestWave: number;
  finalSectorId: GameSectorId;
  enemiesDestroyed: number;
  bossesDefeated: number;
  shotsFired: number;
  shotsHit: number;
  longestCombo: number;
  powerupsCollected: number;
  livesLost: number;
  won: boolean;
  inputKind: GameInputKind;
  endedReason: string;
  clientEndedAt: string | null;
  powers: GameRunPowerSummary[];
  sectors: GameRunSectorSummary[];
};

export type GameSettingsPatch = Partial<{
  musicVolume: number;
  effectsVolume: number;
  screenShake: boolean;
  reducedMotion: boolean;
}>;

export type RunCompletedSyncEvent = {
  eventId: string;
  kind: "run.completed";
  version: 2;
  payload: GameRunSummaryInput;
};

export type SettingsUpdatedSyncEvent = {
  eventId: string;
  kind: "settings.updated";
  version: 1;
  payload: {
    baseRevision: number;
    settings: GameSettingsPatch;
  };
};

export type GameSyncEvent =
  | RunCompletedSyncEvent
  | SettingsUpdatedSyncEvent;

export type ValidatedGameSyncEvent =
  | (Omit<RunCompletedSyncEvent, "payload"> & {
      payload: ValidatedRunSummary;
    })
  | SettingsUpdatedSyncEvent;

export type SyncStatsRequest = {
  action: "sync";
  accessCode: string;
  events: GameSyncEvent[];
};

export type GameStatsRequest =
  | CreateStatsRequest
  | ConnectStatsRequest
  | RenameStatsRequest
  | RecordStatsRequest
  | SyncStatsRequest;

export type PlayerExtendedTotals = {
  enemiesDestroyed: number;
  bossesDefeated: number;
  shotsFired: number;
  shotsHit: number;
  longestCombo: number;
  powerupsCollected: number;
  longestRunMs: number;
  wins: number;
  arduinoRuns: number;
  bestAccuracyPermille: number;
};

export type PlayerModeStats = {
  modeId: GameModeId;
  difficultyId: GameDifficultyId;
  gamesPlayed: number;
  totalScore: number;
  highScore: number;
  highestWave: number;
  enemiesDestroyed: number;
  bossesDefeated: number;
  totalDurationMs: number;
  wins: number;
};

export type PlayerPowerStats = {
  powerId: GamePowerId;
  collectedCount: number;
  activatedCount: number;
};

export type PlayerAchievementProgress = {
  achievementId: GameAchievementId;
  progress: number;
  unlockedAt: string | null;
};

export type PlayerUnlock = {
  unlockId: string;
  unlockedAt: string;
};

export type PlayerGameSettings = {
  revision: number;
  musicVolume: number;
  effectsVolume: number;
  screenShake: boolean;
  reducedMotion: boolean;
};

export type PlayerProgression = {
  schemaVersion: 2;
  serverRevision: number;
  totals: PlayerExtendedTotals;
  modes: PlayerModeStats[];
  powers: PlayerPowerStats[];
  achievements: PlayerAchievementProgress[];
  unlocks: PlayerUnlock[];
  settings: PlayerGameSettings;
};

export type LeaderboardResponse = {
  leaderboard: LeaderboardEntry[];
};

export type ProfileResponse = {
  profile: PlayerStats;
  accessCode?: string;
  recorded?: boolean;
  progression?: PlayerProgression;
};

export type GameSyncResult = {
  eventId: string;
  status: "applied" | "duplicate";
  unlockedAchievementIds: GameAchievementId[];
};

export type SyncResponse = ProfileResponse & {
  results: GameSyncResult[];
};

export type ErrorResponse = {
  error: string;
  code: string;
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type ValidatedRun = {
  runId: string;
  score: number;
  level: number;
  durationMs: number;
};

type RandomBytes = (length: number) => Uint8Array;

type RandomValuesProvider = {
  getRandomValues<T extends Uint8Array>(array: T): T;
};

const ACCESS_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ACCESS_CODE_LENGTH = 20;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const NICKNAME_PATTERN =
  /^(?=.*[\p{L}\p{N}])[\p{L}\p{M}\p{N} _.-]+$/u;
const MAX_NICKNAME_LENGTH = 20;

const RANDOM_NICKNAME_ADJECTIVES: Record<
  GameStatsLanguage,
  readonly string[]
> = {
  uk: ["Сміливий", "Зоряний", "Швидкий", "Космо"],
  de: ["Mutig", "Stern", "Schnell", "Kosmo"],
  en: ["Brave", "Stellar", "Swift", "Cosmic"],
};

function defaultRandomBytes(length: number) {
  const secureCrypto = (globalThis as { crypto?: RandomValuesProvider }).crypto;
  if (!secureCrypto?.getRandomValues) {
    throw new Error("Secure random values are unavailable in this environment.");
  }

  return secureCrypto.getRandomValues(new Uint8Array(length));
}

function secureRandomFraction() {
  const bytes = defaultRandomBytes(4);
  const value =
    bytes[0] * 0x1000000 + bytes[1] * 0x10000 + bytes[2] * 0x100 + bytes[3];
  return value / 0x100000000;
}

export function normalizeNickname(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function validateNickname(
  value: unknown,
  options: { allowBlank?: boolean } = {},
): ValidationResult<string> {
  if (typeof value !== "string") {
    return { ok: false, error: "Nickname must be text." };
  }

  const nickname = normalizeNickname(value);
  if (!nickname) {
    return options.allowBlank
      ? { ok: true, value: "" }
      : { ok: false, error: "Nickname is required." };
  }

  const length = Array.from(nickname).length;
  if (length < 2 || length > MAX_NICKNAME_LENGTH) {
    return {
      ok: false,
      error: `Nickname must contain 2-${MAX_NICKNAME_LENGTH} characters.`,
    };
  }

  if (!NICKNAME_PATTERN.test(nickname)) {
    return { ok: false, error: "Nickname contains unsupported characters." };
  }

  return { ok: true, value: nickname };
}

export function normalizeAccessCode(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function validateAccessCode(value: unknown): ValidationResult<string> {
  const accessCode = normalizeAccessCode(value);
  const validCharacters = new RegExp(`^[${ACCESS_CODE_ALPHABET}]+$`);

  if (
    accessCode.length !== ACCESS_CODE_LENGTH ||
    !validCharacters.test(accessCode)
  ) {
    return {
      ok: false,
      error: "Access code must contain 20 valid Base32 characters.",
    };
  }

  return { ok: true, value: accessCode };
}

export function formatAccessCode(value: unknown) {
  const accessCode = normalizeAccessCode(value);
  return accessCode.match(/.{1,5}/g)?.join("-") ?? "";
}

export function generateAccessCode(
  randomBytes: RandomBytes = defaultRandomBytes,
) {
  const bytes = randomBytes(ACCESS_CODE_LENGTH);
  if (!(bytes instanceof Uint8Array) || bytes.length !== ACCESS_CODE_LENGTH) {
    throw new Error(`Random source must return ${ACCESS_CODE_LENGTH} bytes.`);
  }

  const code = Array.from(
    bytes,
    (byte) => ACCESS_CODE_ALPHABET[byte & 31],
  ).join("");
  return formatAccessCode(code);
}

export function generateRandomNickname(
  language: GameStatsLanguage,
  randomValue = secureRandomFraction(),
) {
  const adjectives =
    RANDOM_NICKNAME_ADJECTIVES[language] ?? RANDOM_NICKNAME_ADJECTIVES.en;
  const normalizedRandom =
    Number.isFinite(randomValue) && randomValue >= 0
      ? randomValue - Math.floor(randomValue)
      : 0;
  const bucket = Math.floor(normalizedRandom * 1_000_000);
  const adjective = adjectives[bucket % adjectives.length];
  const suffix = String(bucket).padStart(6, "0");
  return `${adjective}${suffix}`;
}

export function validateLanguage(value: unknown): ValidationResult<GameStatsLanguage> {
  return typeof value === "string" &&
    (GAME_STATS_LANGUAGES as readonly string[]).includes(value)
    ? { ok: true, value: value as GameStatsLanguage }
    : { ok: false, error: "Unsupported language." };
}

function validateInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): ValidationResult<number> {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return {
      ok: false,
      error: `${name} must be an integer between ${minimum} and ${maximum}.`,
    };
  }

  return { ok: true, value };
}

export function validateRun(value: unknown): ValidationResult<ValidatedRun> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Run data must be an object." };
  }

  const run = value as Record<string, unknown>;
  if (typeof run.runId !== "string" || !RUN_ID_PATTERN.test(run.runId)) {
    return {
      ok: false,
      error: "Run ID must contain 8-64 letters, numbers, underscores, or dashes.",
    };
  }

  const score = validateInteger(run.score, "Score", 0, 100_000_000);
  if (!score.ok) return score;

  const level = validateInteger(run.level, "Level", 1, 9);
  if (!level.ok) return level;

  const durationMs = validateInteger(
    run.durationMs,
    "Duration",
    0,
    21_600_000,
  );
  if (!durationMs.ok) return durationMs;

  const maximumLevel = Math.min(9, 1 + Math.floor(durationMs.value / 22_000));
  if (level.value > maximumLevel) {
    return { ok: false, error: "Level is not plausible for the run duration." };
  }

  if (score.value % 10 !== 0) {
    return { ok: false, error: "Score is not plausible for this run." };
  }

  return {
    ok: true,
    value: {
      runId: run.runId,
      score: score.value,
      level: level.value,
      durationMs: durationMs.value,
    },
  };
}

function validateEnumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T,
  name: string,
): ValidationResult<T> {
  if (value === undefined) return { ok: true, value: fallback };
  return typeof value === "string" && values.includes(value as T)
    ? { ok: true, value: value as T }
    : { ok: false, error: `${name} is unsupported.` };
}

function validateOptionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback = 0,
) {
  return validateInteger(value ?? fallback, name, minimum, maximum);
}

export function validateRunSummary(
  value: unknown,
): ValidationResult<ValidatedRunSummary> {
  const core = validateRun(value);
  if (!core.ok) return core;
  const candidate = value as Record<string, unknown>;

  const modeId = validateEnumValue(
    candidate.modeId,
    GAME_MODE_IDS,
    "classic",
    "Mode",
  );
  if (!modeId.ok) return modeId;
  const difficultyId = validateEnumValue(
    candidate.difficultyId,
    GAME_DIFFICULTY_IDS,
    "pilot",
    "Difficulty",
  );
  if (!difficultyId.ok) return difficultyId;
  const finalSectorId = validateEnumValue(
    candidate.finalSectorId,
    GAME_SECTOR_IDS,
    "starfield",
    "Sector",
  );
  if (!finalSectorId.ok) return finalSectorId;

  const highestWave = validateOptionalInteger(
    candidate.highestWave,
    "Highest wave",
    1,
    10_000,
    core.value.level,
  );
  if (!highestWave.ok) return highestWave;

  const counters = {
    enemiesDestroyed: validateOptionalInteger(
      candidate.enemiesDestroyed,
      "Enemies destroyed",
      0,
      100_000_000,
    ),
    bossesDefeated: validateOptionalInteger(
      candidate.bossesDefeated,
      "Bosses defeated",
      0,
      1_000_000,
    ),
    shotsFired: validateOptionalInteger(
      candidate.shotsFired,
      "Shots fired",
      0,
      1_000_000_000,
    ),
    shotsHit: validateOptionalInteger(
      candidate.shotsHit,
      "Shots hit",
      0,
      1_000_000_000,
    ),
    longestCombo: validateOptionalInteger(
      candidate.longestCombo,
      "Longest combo",
      0,
      100_000_000,
    ),
    powerupsCollected: validateOptionalInteger(
      candidate.powerupsCollected,
      "Power-ups collected",
      0,
      100_000_000,
    ),
    livesLost: validateOptionalInteger(
      candidate.livesLost,
      "Lives lost",
      0,
      1_000_000,
    ),
  } as const;
  if (!counters.enemiesDestroyed.ok) return counters.enemiesDestroyed;
  if (!counters.bossesDefeated.ok) return counters.bossesDefeated;
  if (!counters.shotsFired.ok) return counters.shotsFired;
  if (!counters.shotsHit.ok) return counters.shotsHit;
  if (!counters.longestCombo.ok) return counters.longestCombo;
  if (!counters.powerupsCollected.ok) return counters.powerupsCollected;
  if (!counters.livesLost.ok) return counters.livesLost;
  if (counters.shotsHit.value > counters.shotsFired.value) {
    return { ok: false, error: "Shots hit cannot exceed shots fired." };
  }
  const maximumWave = Math.min(
    modeId.value === "expedition" ? 9 : 10_000,
    1 + Math.floor(core.value.durationMs / 22_000),
  );
  if (highestWave.value > maximumWave) {
    return { ok: false, error: "Highest wave is not plausible for the run duration." };
  }
  const maximumBosses =
    modeId.value === "classic" ? 0 : Math.floor(highestWave.value / 3);
  if (counters.bossesDefeated.value > maximumBosses) {
    return { ok: false, error: "Boss count is not plausible for the selected mode and wave." };
  }
  const maximumEnemies = Math.floor(core.value.durationMs / 100);
  if (counters.enemiesDestroyed.value > maximumEnemies) {
    return { ok: false, error: "Enemy count is not plausible for the run duration." };
  }
  if (counters.longestCombo.value > counters.enemiesDestroyed.value) {
    return { ok: false, error: "Combo cannot exceed destroyed enemies." };
  }
  if (
    counters.powerupsCollected.value >
    counters.enemiesDestroyed.value + counters.bossesDefeated.value
  ) {
    return { ok: false, error: "Power-up count is not plausible for destroyed threats." };
  }
  if (
    counters.livesLost.value >
    3 +
      counters.powerupsCollected.value +
      highestWave.value +
      Math.floor(core.value.durationMs / 30_000)
  ) {
    return { ok: false, error: "Lives lost is not plausible for available repairs." };
  }
  // An omitted sector must resolve to the same value the SQL CHECK derives from
  // mode+wave. A fixed fallback made this validator accept a payload that
  // `game_runs_progression_check` would reject with SQLSTATE 23514. No in-repo
  // caller reaches that state (the adapter always sends a sector, and the legacy
  // `record`/v1-migration paths default to Classic, whose derived sector is
  // `starfield`), so this is contract hygiene rather than an observed outage.
  const derivedSectorId = getGameSectorForWave(modeId.value, highestWave.value);
  const resolvedSectorId =
    candidate.finalSectorId === undefined ? derivedSectorId : finalSectorId.value;
  if (resolvedSectorId !== derivedSectorId) {
    return { ok: false, error: "Final sector does not match the selected mode and wave." };
  }

  const powersValue = candidate.powers ?? [];
  if (!Array.isArray(powersValue) || powersValue.length > GAME_POWER_IDS.length) {
    return { ok: false, error: "Power summary is invalid." };
  }
  const powers: GameRunPowerSummary[] = [];
  for (const rawPower of powersValue) {
    if (!rawPower || typeof rawPower !== "object" || Array.isArray(rawPower)) {
      return { ok: false, error: "Power summary is invalid." };
    }
    const power = rawPower as Record<string, unknown>;
    const powerId = validateEnumValue(
      power.powerId,
      GAME_POWER_IDS,
      "shield",
      "Power",
    );
    if (!powerId.ok || power.powerId === undefined) {
      return { ok: false, error: "Power summary has an unsupported ID." };
    }
    const collectedCount = validateOptionalInteger(
      power.collectedCount,
      "Power collected count",
      0,
      1_000_000,
    );
    if (!collectedCount.ok) return collectedCount;
    const activatedCount = validateOptionalInteger(
      power.activatedCount,
      "Power activation count",
      0,
      1_000_000,
    );
    if (!activatedCount.ok) return activatedCount;
    if (powers.some((entry) => entry.powerId === powerId.value)) {
      return { ok: false, error: "Power IDs must be unique within a run." };
    }
    powers.push({
      powerId: powerId.value,
      collectedCount: collectedCount.value,
      activatedCount: activatedCount.value,
    });
  }
  if (
    powers.reduce((total, power) => total + power.collectedCount, 0) >
    counters.powerupsCollected.value
  ) {
    return { ok: false, error: "Power collection details exceed the run total." };
  }
  const maximumActivationsPerPower =
    1 + Math.floor(core.value.durationMs / 1_000);
  if (
    powers.some(
      (power) => power.activatedCount > maximumActivationsPerPower,
    )
  ) {
    return { ok: false, error: "Power activation count is not plausible for the run duration." };
  }

  const sectorsValue = candidate.sectors ?? [];
  if (!Array.isArray(sectorsValue) || sectorsValue.length > 64) {
    return { ok: false, error: "Sector summary is invalid." };
  }
  const sectors: GameRunSectorSummary[] = [];
  for (const rawSector of sectorsValue) {
    if (!rawSector || typeof rawSector !== "object" || Array.isArray(rawSector)) {
      return { ok: false, error: "Sector summary is invalid." };
    }
    const sector = rawSector as Record<string, unknown>;
    const sectorIndex = validateInteger(
      sector.sectorIndex,
      "Sector index",
      0,
      63,
    );
    if (!sectorIndex.ok) return sectorIndex;
    const sectorId = validateEnumValue(
      sector.sectorId,
      GAME_SECTOR_IDS,
      "starfield",
      "Sector",
    );
    if (!sectorId.ok || sector.sectorId === undefined) {
      return { ok: false, error: "Sector summary has an unsupported ID." };
    }
    if (typeof sector.completed !== "boolean") {
      return { ok: false, error: "Sector completion flag is invalid." };
    }
    const livesLost = validateInteger(
      sector.livesLost,
      "Sector lives lost",
      0,
      1_000_000,
    );
    if (!livesLost.ok) return livesLost;
    const durationMs = validateInteger(
      sector.durationMs,
      "Sector duration",
      0,
      21_600_000,
    );
    if (!durationMs.ok) return durationMs;
    if (sectors.some((entry) => entry.sectorIndex === sectorIndex.value)) {
      return { ok: false, error: "Sector indexes must be unique within a run." };
    }
    sectors.push({
      sectorIndex: sectorIndex.value,
      sectorId: sectorId.value,
      completed: sector.completed,
      livesLost: livesLost.value,
      durationMs: durationMs.value,
    });
  }
  const completedSectorCount = sectors.filter((sector) => sector.completed).length;
  if (
    completedSectorCount > highestWave.value ||
    completedSectorCount > Math.floor(core.value.durationMs / 20_000)
  ) {
    return { ok: false, error: "Completed sector count is not plausible for the run." };
  }
  if (
    sectors.reduce((total, sector) => total + sector.durationMs, 0) >
    core.value.durationMs
  ) {
    return { ok: false, error: "Sector durations exceed the run duration." };
  }
  if (
    sectors.reduce((total, sector) => total + sector.livesLost, 0) >
    counters.livesLost.value
  ) {
    return { ok: false, error: "Sector life losses exceed the run total." };
  }

  const inputKind = validateEnumValue(
    candidate.inputKind,
    ["unknown", "keyboard", "touch", "arduino", "mixed"] as const,
    "unknown",
    "Input kind",
  );
  if (!inputKind.ok) return inputKind;
  const endedReason = candidate.endedReason ?? "finished";
  if (
    typeof endedReason !== "string" ||
    !/^[a-z][a-z0-9_-]{0,31}$/.test(endedReason)
  ) {
    return { ok: false, error: "Run end reason is invalid." };
  }
  if (candidate.won !== undefined && typeof candidate.won !== "boolean") {
    return { ok: false, error: "Run victory flag is invalid." };
  }
  const won = candidate.won ?? false;
  if (won && (modeId.value !== "expedition" || highestWave.value !== 9)) {
    return { ok: false, error: "Victory is only valid after the final expedition wave." };
  }
  if ((endedReason === "victory") !== won) {
    return { ok: false, error: "Victory flag and run end reason do not match." };
  }

  let clientEndedAt: string | null = null;
  if (candidate.clientEndedAt !== undefined && candidate.clientEndedAt !== null) {
    if (typeof candidate.clientEndedAt !== "string") {
      return { ok: false, error: "Run end timestamp is invalid." };
    }
    const parsedDate = new Date(candidate.clientEndedAt);
    if (Number.isNaN(parsedDate.getTime())) {
      return { ok: false, error: "Run end timestamp is invalid." };
    }
    clientEndedAt = parsedDate.toISOString();
  }

  return {
    ok: true,
    value: {
      ...core.value,
      modeId: modeId.value,
      difficultyId: difficultyId.value,
      highestWave: highestWave.value,
      finalSectorId: resolvedSectorId,
      enemiesDestroyed: counters.enemiesDestroyed.value,
      bossesDefeated: counters.bossesDefeated.value,
      shotsFired: counters.shotsFired.value,
      shotsHit: counters.shotsHit.value,
      longestCombo: counters.longestCombo.value,
      powerupsCollected: counters.powerupsCollected.value,
      livesLost: counters.livesLost.value,
      won,
      inputKind: inputKind.value,
      endedReason,
      clientEndedAt,
      powers: powers.sort((left, right) =>
        left.powerId.localeCompare(right.powerId),
      ),
      sectors: sectors.sort(
        (left, right) => left.sectorIndex - right.sectorIndex,
      ),
    },
  };
}

export function validateGameSettingsPatch(
  value: unknown,
): ValidationResult<GameSettingsPatch> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Settings patch must be an object." };
  }
  const candidate = value as Record<string, unknown>;
  const allowedKeys = [
    "musicVolume",
    "effectsVolume",
    "screenShake",
    "reducedMotion",
  ];
  if (
    Object.keys(candidate).length === 0 ||
    Object.keys(candidate).some((key) => !allowedKeys.includes(key))
  ) {
    return { ok: false, error: "Settings patch contains unsupported fields." };
  }

  const settings: GameSettingsPatch = {};
  for (const key of ["musicVolume", "effectsVolume"] as const) {
    if (candidate[key] !== undefined) {
      const result = validateInteger(candidate[key], key, 0, 100);
      if (!result.ok) return result;
      settings[key] = result.value;
    }
  }
  for (const key of ["screenShake", "reducedMotion"] as const) {
    if (candidate[key] !== undefined) {
      if (typeof candidate[key] !== "boolean") {
        return { ok: false, error: `${key} must be boolean.` };
      }
      settings[key] = candidate[key];
    }
  }
  return { ok: true, value: settings };
}

function validateIsoDate(
  value: unknown,
  name: string,
  allowNull = false,
): ValidationResult<string | null> {
  if (allowNull && value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, error: `${name} is invalid.` };
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? { ok: false, error: `${name} is invalid.` }
    : { ok: true, value: parsed.toISOString() };
}

export function validatePlayerProgression(
  value: unknown,
): ValidationResult<PlayerProgression> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Player progression is invalid." };
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 2) {
    return { ok: false, error: "Player progression version is unsupported." };
  }
  const serverRevision = validateInteger(
    candidate.serverRevision,
    "Server revision",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (!serverRevision.ok) return serverRevision;

  if (!candidate.totals || typeof candidate.totals !== "object" || Array.isArray(candidate.totals)) {
    return { ok: false, error: "Player totals are invalid." };
  }
  const rawTotals = candidate.totals as Record<string, unknown>;
  const totalFields = [
    "enemiesDestroyed",
    "bossesDefeated",
    "shotsFired",
    "shotsHit",
    "longestCombo",
    "powerupsCollected",
    "wins",
    "arduinoRuns",
  ] as const;
  const totals = {} as PlayerExtendedTotals;
  for (const field of totalFields) {
    const parsed = validateInteger(
      rawTotals[field],
      field,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (!parsed.ok) return parsed;
    totals[field] = parsed.value;
  }
  const longestRunMs = validateInteger(
    rawTotals.longestRunMs,
    "Longest run",
    0,
    21_600_000,
  );
  if (!longestRunMs.ok) return longestRunMs;
  totals.longestRunMs = longestRunMs.value;
  const bestAccuracyPermille = validateInteger(
    rawTotals.bestAccuracyPermille,
    "Best accuracy",
    0,
    1_000,
  );
  if (!bestAccuracyPermille.ok) return bestAccuracyPermille;
  totals.bestAccuracyPermille = bestAccuracyPermille.value;
  if (totals.shotsHit > totals.shotsFired) {
    return { ok: false, error: "Player totals are inconsistent." };
  }

  if (!Array.isArray(candidate.modes) || candidate.modes.length > 9) {
    return { ok: false, error: "Mode statistics are invalid." };
  }
  const modes: PlayerModeStats[] = [];
  for (const rawMode of candidate.modes) {
    if (!rawMode || typeof rawMode !== "object" || Array.isArray(rawMode)) {
      return { ok: false, error: "Mode statistics are invalid." };
    }
    const mode = rawMode as Record<string, unknown>;
    if (
      typeof mode.modeId !== "string" ||
      !GAME_MODE_IDS.includes(mode.modeId as GameModeId) ||
      typeof mode.difficultyId !== "string" ||
      !GAME_DIFFICULTY_IDS.includes(mode.difficultyId as GameDifficultyId)
    ) {
      return { ok: false, error: "Mode statistics contain unsupported IDs." };
    }
    if (
      modes.some(
        (entry) =>
          entry.modeId === mode.modeId &&
          entry.difficultyId === mode.difficultyId,
      )
    ) {
      return { ok: false, error: "Mode statistics contain duplicates." };
    }
    const integerFields = [
      "gamesPlayed",
      "totalScore",
      "enemiesDestroyed",
      "bossesDefeated",
      "totalDurationMs",
      "wins",
    ] as const;
    const parsedMode = {
      modeId: mode.modeId as GameModeId,
      difficultyId: mode.difficultyId as GameDifficultyId,
    } as PlayerModeStats;
    for (const field of integerFields) {
      const parsed = validateInteger(
        mode[field],
        field,
        0,
        Number.MAX_SAFE_INTEGER,
      );
      if (!parsed.ok) return parsed;
      parsedMode[field] = parsed.value;
    }
    const highScore = validateInteger(mode.highScore, "High score", 0, 100_000_000);
    if (!highScore.ok) return highScore;
    parsedMode.highScore = highScore.value;
    const highestWave = validateInteger(mode.highestWave, "Highest wave", 0, 10_000);
    if (!highestWave.ok) return highestWave;
    parsedMode.highestWave = highestWave.value;
    if (parsedMode.wins > parsedMode.gamesPlayed) {
      return { ok: false, error: "Mode statistics are inconsistent." };
    }
    modes.push(parsedMode);
  }

  if (!Array.isArray(candidate.powers) || candidate.powers.length > GAME_POWER_IDS.length) {
    return { ok: false, error: "Power statistics are invalid." };
  }
  const powers: PlayerPowerStats[] = [];
  for (const rawPower of candidate.powers) {
    if (!rawPower || typeof rawPower !== "object" || Array.isArray(rawPower)) {
      return { ok: false, error: "Power statistics are invalid." };
    }
    const power = rawPower as Record<string, unknown>;
    if (
      typeof power.powerId !== "string" ||
      !GAME_POWER_IDS.includes(power.powerId as GamePowerId) ||
      powers.some((entry) => entry.powerId === power.powerId)
    ) {
      return { ok: false, error: "Power statistics contain unsupported or duplicate IDs." };
    }
    const collectedCount = validateInteger(
      power.collectedCount,
      "Power collection count",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (!collectedCount.ok) return collectedCount;
    const activatedCount = validateInteger(
      power.activatedCount,
      "Power activation count",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (!activatedCount.ok) return activatedCount;
    powers.push({
      powerId: power.powerId as GamePowerId,
      collectedCount: collectedCount.value,
      activatedCount: activatedCount.value,
    });
  }

  if (
    !Array.isArray(candidate.achievements) ||
    candidate.achievements.length > GAME_ACHIEVEMENTS.length
  ) {
    return { ok: false, error: "Achievement progression is invalid." };
  }
  const achievements: PlayerAchievementProgress[] = [];
  for (const rawAchievement of candidate.achievements) {
    if (!rawAchievement || typeof rawAchievement !== "object" || Array.isArray(rawAchievement)) {
      return { ok: false, error: "Achievement progression is invalid." };
    }
    const achievement = rawAchievement as Record<string, unknown>;
    const definition = GAME_ACHIEVEMENTS.find(
      (entry) => entry.id === achievement.achievementId,
    );
    if (
      !definition ||
      achievements.some(
        (entry) => entry.achievementId === achievement.achievementId,
      )
    ) {
      return { ok: false, error: "Achievement progression contains unsupported or duplicate IDs." };
    }
    const progress = validateInteger(
      achievement.progress,
      "Achievement progress",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (!progress.ok) return progress;
    const unlockedAt = validateIsoDate(
      achievement.unlockedAt,
      "Achievement unlock date",
      true,
    );
    if (!unlockedAt.ok) return unlockedAt;
    if (unlockedAt.value !== null && progress.value < definition.target) {
      return { ok: false, error: "Achievement unlock state is inconsistent." };
    }
    achievements.push({
      achievementId: definition.id,
      progress: progress.value,
      unlockedAt: unlockedAt.value,
    });
  }

  if (!Array.isArray(candidate.unlocks) || candidate.unlocks.length > 256) {
    return { ok: false, error: "Player unlocks are invalid." };
  }
  const unlocks: PlayerUnlock[] = [];
  for (const rawUnlock of candidate.unlocks) {
    if (!rawUnlock || typeof rawUnlock !== "object" || Array.isArray(rawUnlock)) {
      return { ok: false, error: "Player unlocks are invalid." };
    }
    const unlock = rawUnlock as Record<string, unknown>;
    if (
      typeof unlock.unlockId !== "string" ||
      !/^[a-z][a-z0-9:_-]{0,63}$/.test(unlock.unlockId) ||
      unlocks.some((entry) => entry.unlockId === unlock.unlockId)
    ) {
      return { ok: false, error: "Player unlocks contain invalid or duplicate IDs." };
    }
    const unlockedAt = validateIsoDate(unlock.unlockedAt, "Unlock date");
    if (!unlockedAt.ok) return unlockedAt;
    if (unlockedAt.value === null) {
      return { ok: false, error: "Unlock date is invalid." };
    }
    unlocks.push({ unlockId: unlock.unlockId, unlockedAt: unlockedAt.value });
  }

  if (!candidate.settings || typeof candidate.settings !== "object" || Array.isArray(candidate.settings)) {
    return { ok: false, error: "Player settings are invalid." };
  }
  const rawSettings = candidate.settings as Record<string, unknown>;
  const revision = validateInteger(
    rawSettings.revision,
    "Settings revision",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (!revision.ok) return revision;
  const musicVolume = validateInteger(rawSettings.musicVolume, "Music volume", 0, 100);
  if (!musicVolume.ok) return musicVolume;
  const effectsVolume = validateInteger(rawSettings.effectsVolume, "Effects volume", 0, 100);
  if (!effectsVolume.ok) return effectsVolume;
  if (
    typeof rawSettings.screenShake !== "boolean" ||
    typeof rawSettings.reducedMotion !== "boolean"
  ) {
    return { ok: false, error: "Player settings flags are invalid." };
  }

  return {
    ok: true,
    value: {
      schemaVersion: 2,
      serverRevision: serverRevision.value,
      totals,
      modes,
      powers,
      achievements,
      unlocks,
      settings: {
        revision: revision.value,
        musicVolume: musicVolume.value,
        effectsVolume: effectsVolume.value,
        screenShake: rawSettings.screenShake,
        reducedMotion: rawSettings.reducedMotion,
      },
    },
  };
}

export function validateGameSyncResults(
  value: unknown,
): ValidationResult<GameSyncResult[]> {
  if (!Array.isArray(value) || value.length > MAX_GAME_SYNC_EVENTS) {
    return { ok: false, error: "Sync results are invalid." };
  }
  const results: GameSyncResult[] = [];
  for (const rawResult of value) {
    if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
      return { ok: false, error: "Sync results are invalid." };
    }
    const result = rawResult as Record<string, unknown>;
    if (
      typeof result.eventId !== "string" ||
      !RUN_ID_PATTERN.test(result.eventId) ||
      results.some((entry) => entry.eventId === result.eventId) ||
      (result.status !== "applied" && result.status !== "duplicate") ||
      !Array.isArray(result.unlockedAchievementIds)
    ) {
      return { ok: false, error: "Sync results contain invalid fields." };
    }
    const unlockedAchievementIds: GameAchievementId[] = [];
    for (const rawId of result.unlockedAchievementIds) {
      const definition = GAME_ACHIEVEMENTS.find((entry) => entry.id === rawId);
      if (!definition || unlockedAchievementIds.includes(definition.id)) {
        return { ok: false, error: "Sync results contain invalid achievement IDs." };
      }
      unlockedAchievementIds.push(definition.id);
    }
    results.push({
      eventId: result.eventId,
      status: result.status,
      unlockedAchievementIds,
    });
  }
  return { ok: true, value: results };
}

export function validateGameSyncEvent(
  value: unknown,
): ValidationResult<ValidatedGameSyncEvent> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Sync event must be an object." };
  }
  const event = value as Record<string, unknown>;
  if (typeof event.eventId !== "string" || !RUN_ID_PATTERN.test(event.eventId)) {
    return { ok: false, error: "Sync event ID is invalid." };
  }

  if (event.kind === "run.completed" && event.version === 2) {
    const payload = validateRunSummary(event.payload);
    if (!payload.ok) return payload;
    if (payload.value.runId !== event.eventId) {
      return { ok: false, error: "Run ID must match its sync event ID." };
    }
    return {
      ok: true,
      value: {
        eventId: event.eventId,
        kind: "run.completed",
        version: 2,
        payload: payload.value,
      },
    };
  }

  if (event.kind === "settings.updated" && event.version === 1) {
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
      return { ok: false, error: "Settings event payload is invalid." };
    }
    const payload = event.payload as Record<string, unknown>;
    const baseRevision = validateInteger(
      payload.baseRevision,
      "Settings revision",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (!baseRevision.ok) return baseRevision;
    const settings = validateGameSettingsPatch(payload.settings);
    if (!settings.ok) return settings;
    return {
      ok: true,
      value: {
        eventId: event.eventId,
        kind: "settings.updated",
        version: 1,
        payload: { baseRevision: baseRevision.value, settings: settings.value },
      },
    };
  }

  return { ok: false, error: "Sync event kind or version is unsupported." };
}

export function validateGameSyncEvents(
  value: unknown,
): ValidationResult<ValidatedGameSyncEvent[]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_GAME_SYNC_EVENTS) {
    return {
      ok: false,
      error: `Sync requests must contain 1-${MAX_GAME_SYNC_EVENTS} events.`,
    };
  }
  const events: ValidatedGameSyncEvent[] = [];
  for (const rawEvent of value) {
    const event = validateGameSyncEvent(rawEvent);
    if (!event.ok) return event;
    if (events.some((entry) => entry.eventId === event.value.eventId)) {
      return { ok: false, error: "Sync event IDs must be unique." };
    }
    events.push(event.value);
  }
  return { ok: true, value: events };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function generateRunId(randomBytes: RandomBytes = defaultRandomBytes) {
  return `run_${normalizeAccessCode(generateAccessCode(randomBytes))}`;
}
