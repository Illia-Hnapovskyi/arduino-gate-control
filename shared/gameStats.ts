export const GAME_STATS_API_PATH = "/api/stats";

export const GAME_STATS_LANGUAGES = ["uk", "de", "en"] as const;

export type GameStatsLanguage = (typeof GAME_STATS_LANGUAGES)[number];

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

export type GameStatsRequest =
  | CreateStatsRequest
  | ConnectStatsRequest
  | RenameStatsRequest
  | RecordStatsRequest;

export type LeaderboardResponse = {
  leaderboard: LeaderboardEntry[];
};

export type ProfileResponse = {
  profile: PlayerStats;
  accessCode?: string;
  recorded?: boolean;
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

export function generateRunId(randomBytes: RandomBytes = defaultRandomBytes) {
  return `run_${normalizeAccessCode(generateAccessCode(randomBytes))}`;
}
