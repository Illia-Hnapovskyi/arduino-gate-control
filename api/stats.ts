import { createHash, createHmac } from "node:crypto";

import postgres from "postgres";

import {
  verifySupabaseToken,
  type VerifiedAuth,
} from "../server/authVerify.js";
import {
  GAME_ACHIEVEMENTS,
  GAME_STATS_ACTIONS,
  canonicalJson,
  evaluateCredentialMatrix,
  generateRandomNickname,
  type GameAchievementId,
  type GameStatsAction,
  type GameStatsLanguage,
  type GameSyncResult,
  type LeaderboardEntry,
  type PlayerAchievementProgress,
  type PlayerExtendedTotals,
  type PlayerGameSettings,
  type PlayerModeStats,
  type PlayerPowerStats,
  type PlayerProgression,
  type PlayerStats,
  type PlayerUnlock,
  type ProfileResponse,
  type SyncResponse,
  type ValidatedGameSyncEvent,
  type ValidatedRunSummary,
  validateGameSyncEvents,
  validateLanguage,
  validateNickname,
  validateRun,
  validateRunSummary,
} from "../shared/gameStats.js";

const MAX_REQUEST_BYTES = 65_536;
const MAX_SAFE_DATABASE_INTEGER = Number.MAX_SAFE_INTEGER;
const LEADERBOARD_LIMIT = 25;
const RATE_LIMIT_RETENTION_DAYS = 2;
// An account-only profile carries no access code, so this is the schema version
// that satisfies game_players_reachable_check from migration 0005.
const ACCOUNT_PROFILE_SCHEMA_VERSION = 3;

const RATE_LIMITS = {
  ipCreate: { bucket: "ip_create", limit: 30, windowSeconds: 3_600 },
  ipWrite: { bucket: "ip_write", limit: 600, windowSeconds: 3_600 },
  profileRecord: {
    bucket: "profile_record",
    limit: 240,
    windowSeconds: 3_600,
  },
  profileRename: {
    bucket: "profile_rename",
    limit: 30,
    windowSeconds: 3_600,
  },
  profileSync: {
    bucket: "profile_sync",
    limit: 300,
    windowSeconds: 3_600,
  },
  accountLink: { bucket: "account_link", limit: 10, windowSeconds: 3_600 },
} as const;

const JSON_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

type SqlClient = ReturnType<typeof postgres>;

// postgres.js transactions expose savepoint(); the base cast used elsewhere
// hides it, so the account-create retry loop uses this widened shape.
type TransactionClient = SqlClient & {
  savepoint<T>(callback: (sql: SqlClient) => T | Promise<T>): Promise<T>;
};

type DatabaseRow = {
  id?: unknown;
  publicId?: unknown;
  nickname: unknown;
  gamesPlayed: unknown;
  totalScore: unknown;
  highScore: unknown;
  highestLevel: unknown;
  totalDurationMs: unknown;
  updatedAt: unknown;
  recorded?: unknown;
  statsRevision?: unknown;
};

type DatabaseError = {
  code?: unknown;
  constraint?: unknown;
  constraint_name?: unknown;
};

type RateLimitBucket =
  | "ip_create"
  | "ip_write"
  | "profile_record"
  | "profile_rename"
  | "profile_sync"
  | "account_link";

type RateLimitRule = {
  amount?: number;
  bucket: RateLimitBucket;
  limit: number;
  scopeHash: string;
  windowSeconds: number;
};

type RateLimitRow = {
  retryAfter: unknown;
};

let databaseClient:
  | { connectionString: string; sql: SqlClient }
  | undefined;

let lastRateLimitCleanup = 0;

function jsonResponse(body: unknown, status = 200, extraHeaders?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function errorResponse(status: number, code: string, error: string) {
  return jsonResponse({ code, error }, status);
}

function reportDatabaseError(context: string, error: unknown) {
  const code =
    error &&
    typeof error === "object" &&
    typeof (error as DatabaseError).code === "string"
      ? ` (${(error as DatabaseError).code})`
      : "";
  console.error(`${context}${code}`);
}

function databaseInteger(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("The database returned an invalid statistics value.");
  }
  return number;
}

function databaseDate(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error("The database returned an invalid timestamp.");
  }
  return date.toISOString();
}

function playerFromRow(row: DatabaseRow): PlayerStats {
  if (typeof row.nickname !== "string") {
    throw new Error("The database returned an invalid nickname.");
  }

  return {
    nickname: row.nickname,
    gamesPlayed: databaseInteger(row.gamesPlayed),
    totalScore: databaseInteger(row.totalScore),
    highScore: databaseInteger(row.highScore),
    highestLevel: databaseInteger(row.highestLevel),
    totalDurationMs: databaseInteger(row.totalDurationMs),
    updatedAt: databaseDate(row.updatedAt),
  };
}

async function getDatabase() {
  const connectionString = process.env.SUPABASE_DATABASE_URL?.trim();
  if (!connectionString) return null;

  if (
    !databaseClient ||
    databaseClient.connectionString !== connectionString
  ) {
    databaseClient = {
      connectionString,
      sql: postgres(connectionString, {
        connect_timeout: 5,
        idle_timeout: 20,
        max: 1,
        prepare: false,
        ssl: "require",
      }),
    };
  }
  return databaseClient.sql;
}

async function pseudonymizeRateLimitScope(scope: string) {
  const databaseUrl = process.env.SUPABASE_DATABASE_URL?.trim();
  const secret = process.env.RATE_LIMIT_SECRET?.trim() || databaseUrl;
  if (!secret) {
    throw new Error("A rate-limit pseudonymization key is unavailable.");
  }

  return createHmac("sha256", secret).update(scope, "utf8").digest("hex");
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Extracts the token from the Authorization header. A blank header, another
// scheme, or a Bearer scheme without a single token yields null, which the
// credential matrix treats as "no bearer credential". Every action fails closed
// on that, and the caller gets AUTH_TOKEN_MISSING rather than a verification
// error about a header that never carried a token.
function extractBearerToken(header: string) {
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function clientAddressScope(request: Request) {
  const address = request.headers
    .get("x-forwarded-for")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  return `ip:${address?.slice(0, 128) || "local-or-unknown"}`;
}

function rateLimitRows(result: unknown): RateLimitRow[] {
  if (!Array.isArray(result)) {
    throw new Error("The database returned an invalid rate-limit result.");
  }
  return result as RateLimitRow[];
}

async function consumeRateLimit(sql: SqlClient, rule: RateLimitRule) {
  const amount = Math.max(1, Math.floor(rule.amount ?? 1));
  const allowedRows = rateLimitRows(await sql`
    WITH consumed AS (
      INSERT INTO game_rate_limits (
        scope_hash,
        bucket,
        window_started_at,
        request_count
      )
      VALUES (${rule.scopeHash}, ${rule.bucket}, NOW(), ${amount})
      ON CONFLICT (scope_hash, bucket) DO UPDATE SET
        window_started_at = CASE
          WHEN game_rate_limits.window_started_at <=
            NOW() - make_interval(secs => ${rule.windowSeconds})
            THEN NOW()
          ELSE game_rate_limits.window_started_at
        END,
        request_count = CASE
          WHEN game_rate_limits.window_started_at <=
            NOW() - make_interval(secs => ${rule.windowSeconds})
            THEN ${amount}
          ELSE game_rate_limits.request_count + ${amount}
        END
      WHERE
        game_rate_limits.window_started_at <=
          NOW() - make_interval(secs => ${rule.windowSeconds})
        OR game_rate_limits.request_count <= ${rule.limit - amount}
      RETURNING window_started_at
    )
    SELECT CEIL(EXTRACT(EPOCH FROM (
      window_started_at + make_interval(secs => ${rule.windowSeconds}) - NOW()
    ))) AS "retryAfter"
    FROM consumed
  `);

  if (allowedRows[0]) return { allowed: true as const, retryAfter: 0 };

  const blockedRows = rateLimitRows(await sql`
    SELECT CEIL(EXTRACT(EPOCH FROM (
      window_started_at + make_interval(secs => ${rule.windowSeconds}) - NOW()
    ))) AS "retryAfter"
    FROM game_rate_limits
    WHERE scope_hash = ${rule.scopeHash} AND bucket = ${rule.bucket}
    LIMIT 1
  `);
  const retryAfterValue = Number(blockedRows[0]?.retryAfter);
  const retryAfter = Number.isFinite(retryAfterValue)
    ? Math.max(1, Math.min(rule.windowSeconds, Math.ceil(retryAfterValue)))
    : rule.windowSeconds;
  return { allowed: false as const, retryAfter };
}

async function cleanExpiredRateLimits(sql: SqlClient) {
  const now = Date.now();
  if (now - lastRateLimitCleanup < 3_600_000) return;
  lastRateLimitCleanup = now;
  try {
    await sql`
      DELETE FROM game_rate_limits
      WHERE window_started_at <
        NOW() - make_interval(days => ${RATE_LIMIT_RETENTION_DAYS})
    `;
  } catch (error) {
    lastRateLimitCleanup = 0;
    throw error;
  }
}

function rateLimitResponse(retryAfter: number) {
  return jsonResponse(
    {
      code: "RATE_LIMITED",
      error: "Too many statistics updates. Please try again later.",
    },
    429,
    { "Retry-After": String(retryAfter) },
  );
}

// Profile-scoped buckets now key on the auth user instead of the access-code
// digest. The bucket names are unchanged, and the scope is HMAC-pseudonymized by
// the same helper, so a raw auth user id never reaches Postgres.
async function enforceMutationRateLimits(
  request: Request,
  sql: SqlClient,
  action: "create" | "record" | "rename" | "sync",
  authUserId: string,
  eventCount = 1,
  recordEventCount = 0,
) {
  await cleanExpiredRateLimits(sql);
  const [ipScopeHash, accountScopeHash] = await Promise.all([
    pseudonymizeRateLimitScope(clientAddressScope(request)),
    pseudonymizeRateLimitScope(`account:${authUserId}`),
  ]);
  const rules: RateLimitRule[] = [];

  if (action === "create") {
    // Establishing an identity is not an ordinary mutation: it consumes the
    // per-address create bucket plus the per-account bucket, never ip_write.
    rules.push({ ...RATE_LIMITS.ipCreate, scopeHash: ipScopeHash });
    rules.push({ ...RATE_LIMITS.accountLink, scopeHash: accountScopeHash });
  } else {
    rules.push({
      ...RATE_LIMITS.ipWrite,
      amount: action === "sync" ? eventCount : 1,
      scopeHash: ipScopeHash,
    });

    if (action === "record") {
      rules.push({ ...RATE_LIMITS.profileRecord, scopeHash: accountScopeHash });
    } else if (action === "sync") {
      rules.push({
        ...RATE_LIMITS.profileSync,
        amount: eventCount,
        scopeHash: accountScopeHash,
      });
      if (recordEventCount > 0) {
        rules.push({
          ...RATE_LIMITS.profileRecord,
          amount: recordEventCount,
          scopeHash: accountScopeHash,
        });
      }
    } else {
      rules.push({ ...RATE_LIMITS.profileRename, scopeHash: accountScopeHash });
    }
  }

  for (const rule of rules) {
    const result = await consumeRateLimit(sql, rule);
    if (!result.allowed) return rateLimitResponse(result.retryAfter);
  }
  return null;
}

function isUniqueNicknameError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const databaseError = error as DatabaseError;
  return (
    databaseError.code === "23505" &&
    (databaseError.constraint === "game_players_nickname_unique" ||
      databaseError.constraint_name === "game_players_nickname_unique")
  );
}

// SQLSTATE 23514 means already-validated data still failed a table CHECK, which
// is shared-validation/SQL contract drift rather than an outage. Only map it for
// the event-apply paths: the same SQLSTATE can also come from infrastructure
// constraints such as `game_rate_limits_bucket_check`, and calling that a
// rejected statistic would be its own misdiagnosis.
function isCheckViolation(error: unknown) {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as DatabaseError).code === "23514"
  );
}

function syncFailureResponse(error: unknown) {
  if (error instanceof SyncEventError) {
    return errorResponse(error.status, error.code, error.message);
  }
  if (isCheckViolation(error)) {
    return errorResponse(
      400,
      "STATISTICS_REJECTED",
      "The submitted statistics failed a database consistency check.",
    );
  }
  return null;
}

function rowsFromResult(result: unknown): DatabaseRow[] {
  if (!Array.isArray(result)) {
    throw new Error("The database returned an invalid result.");
  }
  return result as DatabaseRow[];
}

function resultRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) {
    throw new Error("The database returned an invalid result.");
  }
  return result as T[];
}

function databaseBoolean(value: unknown) {
  if (typeof value !== "boolean") {
    throw new Error("The database returned an invalid boolean.");
  }
  return value;
}

function databaseString(value: unknown) {
  if (typeof value !== "string") {
    throw new Error("The database returned invalid text.");
  }
  return value;
}

async function hasProgressionSchema(sql: SqlClient) {
  const rows = resultRows<Record<string, unknown>>(await sql`
    SELECT
      to_regclass('public.game_sync_events') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'game_players'
          AND column_name = 'stats_revision'
      ) AS available
  `);
  return databaseBoolean(rows[0]?.available);
}

type PlayerRecord = {
  profile: PlayerStats;
  statsRevision: number;
  publicId: string;
};

async function selectPlayerRecord(
  sql: SqlClient,
  playerId: number,
): Promise<PlayerRecord | null> {
  const rows = rowsFromResult(await sql`
    SELECT
      public_id::text AS "publicId",
      nickname,
      LEAST(games_played, ${MAX_SAFE_DATABASE_INTEGER}) AS "gamesPlayed",
      LEAST(total_score, ${MAX_SAFE_DATABASE_INTEGER}) AS "totalScore",
      high_score AS "highScore",
      highest_level AS "highestLevel",
      LEAST(total_duration_ms, ${MAX_SAFE_DATABASE_INTEGER}) AS "totalDurationMs",
      updated_at AS "updatedAt",
      LEAST(stats_revision, ${MAX_SAFE_DATABASE_INTEGER}) AS "statsRevision"
    FROM game_players
    WHERE id = ${playerId}
    LIMIT 1
  `);
  const row = rows[0];
  return row
    ? {
        profile: playerFromRow(row),
        statsRevision: databaseInteger(row.statsRevision),
        publicId: databaseString(row.publicId),
      }
    : null;
}

async function getPlayerProgression(
  sql: SqlClient,
  playerId: number,
  knownRevision?: number,
): Promise<PlayerProgression> {
  const totalsRows = resultRows<Record<string, unknown>>(await sql`
    SELECT
      enemies_destroyed AS "enemiesDestroyed",
      bosses_defeated AS "bossesDefeated",
      shots_fired AS "shotsFired",
      shots_hit AS "shotsHit",
      longest_combo AS "longestCombo",
      powerups_collected AS "powerupsCollected",
      longest_run_ms AS "longestRunMs",
      wins,
      arduino_runs AS "arduinoRuns",
      best_accuracy_permille AS "bestAccuracyPermille"
    FROM game_player_totals
    WHERE player_id = ${playerId}
  `);
  const totalsRow = totalsRows[0];
  const totals: PlayerExtendedTotals = totalsRow
    ? {
        enemiesDestroyed: databaseInteger(totalsRow.enemiesDestroyed),
        bossesDefeated: databaseInteger(totalsRow.bossesDefeated),
        shotsFired: databaseInteger(totalsRow.shotsFired),
        shotsHit: databaseInteger(totalsRow.shotsHit),
        longestCombo: databaseInteger(totalsRow.longestCombo),
        powerupsCollected: databaseInteger(totalsRow.powerupsCollected),
        longestRunMs: databaseInteger(totalsRow.longestRunMs),
        wins: databaseInteger(totalsRow.wins),
        arduinoRuns: databaseInteger(totalsRow.arduinoRuns),
        bestAccuracyPermille: databaseInteger(
          totalsRow.bestAccuracyPermille,
        ),
      }
    : {
        enemiesDestroyed: 0,
        bossesDefeated: 0,
        shotsFired: 0,
        shotsHit: 0,
        longestCombo: 0,
        powerupsCollected: 0,
        longestRunMs: 0,
        wins: 0,
        arduinoRuns: 0,
        bestAccuracyPermille: 0,
      };

  const modes = resultRows<Record<string, unknown>>(await sql`
    SELECT
      mode_id AS "modeId",
      difficulty_id AS "difficultyId",
      games_played AS "gamesPlayed",
      total_score AS "totalScore",
      high_score AS "highScore",
      highest_wave AS "highestWave",
      enemies_destroyed AS "enemiesDestroyed",
      bosses_defeated AS "bossesDefeated",
      total_duration_ms AS "totalDurationMs",
      wins
    FROM game_player_mode_stats
    WHERE player_id = ${playerId}
    ORDER BY mode_id, difficulty_id
  `).map<PlayerModeStats>((row) => ({
    modeId: databaseString(row.modeId) as PlayerModeStats["modeId"],
    difficultyId: databaseString(
      row.difficultyId,
    ) as PlayerModeStats["difficultyId"],
    gamesPlayed: databaseInteger(row.gamesPlayed),
    totalScore: databaseInteger(row.totalScore),
    highScore: databaseInteger(row.highScore),
    highestWave: databaseInteger(row.highestWave),
    enemiesDestroyed: databaseInteger(row.enemiesDestroyed),
    bossesDefeated: databaseInteger(row.bossesDefeated),
    totalDurationMs: databaseInteger(row.totalDurationMs),
    wins: databaseInteger(row.wins),
  }));

  const powers = resultRows<Record<string, unknown>>(await sql`
    SELECT
      power_id AS "powerId",
      collected_count AS "collectedCount",
      activated_count AS "activatedCount"
    FROM game_player_power_stats
    WHERE player_id = ${playerId}
    ORDER BY power_id
  `).map<PlayerPowerStats>((row) => ({
    powerId: databaseString(row.powerId) as PlayerPowerStats["powerId"],
    collectedCount: databaseInteger(row.collectedCount),
    activatedCount: databaseInteger(row.activatedCount),
  }));

  const achievements = resultRows<Record<string, unknown>>(await sql`
    SELECT
      achievement_id AS "achievementId",
      progress_value AS progress,
      unlocked_at AS "unlockedAt"
    FROM game_player_achievements
    WHERE player_id = ${playerId}
    ORDER BY achievement_id
  `).map<PlayerAchievementProgress>((row) => ({
    achievementId: databaseString(
      row.achievementId,
    ) as PlayerAchievementProgress["achievementId"],
    progress: databaseInteger(row.progress),
    unlockedAt: row.unlockedAt === null ? null : databaseDate(row.unlockedAt),
  }));

  const unlocks = resultRows<Record<string, unknown>>(await sql`
    SELECT unlock_id AS "unlockId", unlocked_at AS "unlockedAt"
    FROM game_player_unlocks
    WHERE player_id = ${playerId}
    ORDER BY unlocked_at, unlock_id
  `).map<PlayerUnlock>((row) => ({
    unlockId: databaseString(row.unlockId),
    unlockedAt: databaseDate(row.unlockedAt),
  }));

  const settingsRows = resultRows<Record<string, unknown>>(await sql`
    SELECT
      revision,
      music_volume AS "musicVolume",
      effects_volume AS "effectsVolume",
      screen_shake AS "screenShake",
      reduced_motion AS "reducedMotion"
    FROM game_player_settings
    WHERE player_id = ${playerId}
  `);
  const settingsRow = settingsRows[0];
  const settings: PlayerGameSettings = settingsRow
    ? {
        revision: databaseInteger(settingsRow.revision),
        musicVolume: databaseInteger(settingsRow.musicVolume),
        effectsVolume: databaseInteger(settingsRow.effectsVolume),
        screenShake: databaseBoolean(settingsRow.screenShake),
        reducedMotion: databaseBoolean(settingsRow.reducedMotion),
      }
    : {
        revision: 0,
        musicVolume: 70,
        effectsVolume: 80,
        screenShake: true,
        reducedMotion: false,
      };

  let serverRevision = knownRevision;
  if (serverRevision === undefined) {
    const revisionRows = resultRows<Record<string, unknown>>(await sql`
      SELECT LEAST(stats_revision, ${MAX_SAFE_DATABASE_INTEGER}) AS revision
      FROM game_players
      WHERE id = ${playerId}
    `);
    serverRevision = databaseInteger(revisionRows[0]?.revision);
  }

  return {
    schemaVersion: 2,
    serverRevision,
    totals,
    modes,
    powers,
    achievements,
    unlocks,
    settings,
  };
}

async function selectPlayerSnapshot(sql: SqlClient, playerId: number) {
  return sql.begin(
    "isolation level repeatable read read only",
    async (transaction) => {
      const tx = transaction as unknown as SqlClient;
      const player = await selectPlayerRecord(tx, playerId);
      if (!player) return null;
      return {
        profile: player.profile,
        progression: await getPlayerProgression(
          tx,
          playerId,
          player.statsRevision,
        ),
        publicId: player.publicId,
      };
    },
  );
}

async function getLeaderboard(sql: SqlClient) {
  const rows = rowsFromResult(await sql`
    SELECT
      nickname,
      LEAST(games_played, ${MAX_SAFE_DATABASE_INTEGER}) AS "gamesPlayed",
      LEAST(total_score, ${MAX_SAFE_DATABASE_INTEGER}) AS "totalScore",
      high_score AS "highScore",
      highest_level AS "highestLevel",
      LEAST(total_duration_ms, ${MAX_SAFE_DATABASE_INTEGER}) AS "totalDurationMs",
      updated_at AS "updatedAt"
    FROM game_players
    WHERE games_played > 0
    ORDER BY
      high_score DESC,
      total_score DESC,
      highest_level DESC,
      updated_at ASC,
      nickname ASC
    LIMIT ${LEADERBOARD_LIMIT}
  `);

  return rows.map<LeaderboardEntry>((row, index) => ({
    rank: index + 1,
    ...playerFromRow(row),
  }));
}

// Renaming changes the only public identity a profile has, so it carries the
// same session-revocation check as `create`.
async function renamePlayer(
  sql: SqlClient,
  auth: VerifiedAuth,
  playerId: number,
  nickname: string,
) {
  try {
    return await sql.begin(async (transaction) => {
      const tx = transaction as unknown as SqlClient;
      await assertSessionActive(tx, auth);
      const rows = rowsFromResult(await tx`
        UPDATE game_players
        SET nickname = ${nickname}, updated_at = NOW()
        WHERE id = ${playerId}
        RETURNING
          nickname,
          LEAST(games_played, ${MAX_SAFE_DATABASE_INTEGER}) AS "gamesPlayed",
          LEAST(total_score, ${MAX_SAFE_DATABASE_INTEGER}) AS "totalScore",
          high_score AS "highScore",
          highest_level AS "highestLevel",
          LEAST(total_duration_ms, ${MAX_SAFE_DATABASE_INTEGER}) AS "totalDurationMs",
          updated_at AS "updatedAt"
      `);

      if (!rows[0]) {
        return errorResponse(404, "PROFILE_NOT_FOUND", "Profile was not found.");
      }
      return jsonResponse({
        profile: playerFromRow(rows[0]),
      } satisfies ProfileResponse);
    });
  } catch (error) {
    if (error instanceof SyncEventError) {
      return errorResponse(error.status, error.code, error.message);
    }
    if (isUniqueNicknameError(error)) {
      return errorResponse(409, "NICKNAME_TAKEN", "Nickname is already in use.");
    }
    throw error;
  }
}

class SyncEventError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SyncEventError";
    this.status = status;
    this.code = code;
  }
}

function syncPayloadHash(event: ValidatedGameSyncEvent) {
  return createHash("sha256").update(canonicalJson(event), "utf8").digest("hex");
}

async function updateAchievements(
  sql: SqlClient,
  playerId: number,
  run: ValidatedRunSummary,
) {
  const playerRows = rowsFromResult(await sql`
    SELECT
      nickname,
      games_played AS "gamesPlayed",
      total_score AS "totalScore",
      high_score AS "highScore",
      highest_level AS "highestLevel",
      total_duration_ms AS "totalDurationMs",
      updated_at AS "updatedAt"
    FROM game_players
    WHERE id = ${playerId}
  `);
  const profile = playerFromRow(playerRows[0]);
  const totalsRows = resultRows<Record<string, unknown>>(await sql`
    SELECT
      enemies_destroyed AS "enemiesDestroyed",
      bosses_defeated AS "bossesDefeated",
      longest_combo AS "longestCombo",
      longest_run_ms AS "longestRunMs",
      arduino_runs AS "arduinoRuns",
      best_accuracy_permille AS "bestAccuracyPermille"
    FROM game_player_totals
    WHERE player_id = ${playerId}
  `);
  const totals = totalsRows[0];
  const powerRows = resultRows<Record<string, unknown>>(await sql`
    SELECT COUNT(*) AS count
    FROM game_player_power_stats
    WHERE player_id = ${playerId} AND activated_count > 0
  `);
  const activatedPowerCount = databaseInteger(powerRows[0]?.count);
  const existingRows = resultRows<Record<string, unknown>>(await sql`
    SELECT achievement_id AS "achievementId", unlocked_at AS "unlockedAt"
    FROM game_player_achievements
    WHERE player_id = ${playerId}
  `);
  const alreadyUnlocked = new Set(
    existingRows
      .filter((row) => row.unlockedAt !== null)
      .map((row) => databaseString(row.achievementId)),
  );
  const flawlessSector = run.sectors.some(
    (sector) => sector.completed && sector.livesLost === 0,
  );
  const progress: Record<GameAchievementId, number> = {
    first_run: profile.gamesPlayed,
    first_enemy: databaseInteger(totals?.enemiesDestroyed),
    first_boss: databaseInteger(totals?.bossesDefeated),
    survivor_5m: databaseInteger(totals?.longestRunMs),
    flawless_sector: flawlessSector ? 1 : 0,
    combo_25: databaseInteger(totals?.longestCombo),
    score_10000: profile.highScore,
    sharpshooter: databaseInteger(totals?.bestAccuracyPermille),
    arduino_pilot: databaseInteger(totals?.arduinoRuns),
    power_explorer: activatedPowerCount,
    max_level: profile.highestLevel,
    veteran_10: profile.gamesPlayed,
  };
  const newlyUnlocked: GameAchievementId[] = [];
  const unlockedAt = new Date();
  const achievementRows = GAME_ACHIEVEMENTS.map((achievement) => {
    const value = progress[achievement.id];
    if (value >= achievement.target && !alreadyUnlocked.has(achievement.id)) {
      newlyUnlocked.push(achievement.id);
    }
    return {
      achievement_id: achievement.id,
      player_id: playerId,
      progress_value: value,
      unlocked_at: value >= achievement.target ? unlockedAt : null,
      updated_at: unlockedAt,
    };
  });
  await sql`
    INSERT INTO game_player_achievements ${sql(
      achievementRows,
      "player_id",
      "achievement_id",
      "progress_value",
      "unlocked_at",
      "updated_at"
    )}
    ON CONFLICT (player_id, achievement_id) DO UPDATE SET
      progress_value = GREATEST(
        game_player_achievements.progress_value,
        EXCLUDED.progress_value
      ),
      unlocked_at = COALESCE(
        game_player_achievements.unlocked_at,
        EXCLUDED.unlocked_at
      ),
      updated_at = EXCLUDED.updated_at
  `;
  if (newlyUnlocked.length > 0) {
    const unlockRows = newlyUnlocked.map((achievementId) => ({
      player_id: playerId,
      unlock_id: `achievement:${achievementId}`,
      source_achievement_id: achievementId,
      unlocked_at: unlockedAt,
    }));
    await sql`
      INSERT INTO game_player_unlocks ${sql(
        unlockRows,
        "player_id",
        "unlock_id",
        "source_achievement_id",
        "unlocked_at"
      )}
      ON CONFLICT (player_id, unlock_id) DO NOTHING
    `;
  }
  return newlyUnlocked;
}

async function applyRunSummary(
  sql: SqlClient,
  playerId: number,
  syncEventId: number,
  run: ValidatedRunSummary,
) {
  const existingRuns = resultRows<Record<string, unknown>>(await sql`
    SELECT id FROM game_runs
    WHERE player_id = ${playerId} AND run_id = ${run.runId}
    LIMIT 1
  `);
  if (existingRuns[0]) {
    await sql`
      UPDATE game_runs
      SET sync_event_id = COALESCE(sync_event_id, ${syncEventId})
      WHERE id = ${databaseInteger(existingRuns[0].id)}
    `;
    return { duplicateLegacyRun: true, newlyUnlocked: [] as GameAchievementId[] };
  }

  const runRows = resultRows<Record<string, unknown>>(await sql`
    INSERT INTO game_runs (
      player_id, sync_event_id, run_id, score, level, duration_ms,
      run_version, mode_id, difficulty_id, highest_wave, final_sector_id,
      enemies_destroyed, bosses_defeated, shots_fired, shots_hit,
      longest_combo, powerups_collected, lives_lost, won, input_kind,
      ended_reason, client_ended_at
    ) VALUES (
      ${playerId}, ${syncEventId}, ${run.runId}, ${run.score}, ${run.level},
      ${run.durationMs}, 2, ${run.modeId}, ${run.difficultyId},
      ${run.highestWave}, ${run.finalSectorId}, ${run.enemiesDestroyed},
      ${run.bossesDefeated}, ${run.shotsFired}, ${run.shotsHit},
      ${run.longestCombo}, ${run.powerupsCollected}, ${run.livesLost},
      ${run.won}, ${run.inputKind}, ${run.endedReason},
      ${run.clientEndedAt ? new Date(run.clientEndedAt) : null}
    )
    RETURNING id
  `);
  const runDatabaseId = databaseInteger(runRows[0]?.id);

  if (run.powers.length > 0) {
    const powerRows = run.powers.map((power) => ({
      run_id: runDatabaseId,
      power_id: power.powerId,
      collected_count: power.collectedCount,
      activated_count: power.activatedCount,
    }));
    await sql`
      INSERT INTO game_run_power_stats (
        run_id, power_id, collected_count, activated_count
      ) ${sql(powerRows, "run_id", "power_id", "collected_count", "activated_count")}
    `;
  }
  if (run.sectors.length > 0) {
    const sectorRows = run.sectors.map((sector) => ({
      run_id: runDatabaseId,
      sector_index: sector.sectorIndex,
      sector_id: sector.sectorId,
      completed: sector.completed,
      lives_lost: sector.livesLost,
      duration_ms: sector.durationMs,
    }));
    await sql`
      INSERT INTO game_run_sector_stats (
        run_id, sector_index, sector_id, completed, lives_lost, duration_ms
      ) ${sql(
        sectorRows,
        "run_id",
        "sector_index",
        "sector_id",
        "completed",
        "lives_lost",
        "duration_ms"
      )}
    `;
  }

  // profile_schema_version only ever climbs. Applying a run still promotes a
  // legacy version-1 row to 2, but an account-only profile keeps its 3: it has
  // no access_code_hash, so lowering the marker would fail 0005's validated
  // game_players_reachable_check and roll the whole event back.
  await sql`
    UPDATE game_players
    SET
      games_played = LEAST(games_played + 1, ${MAX_SAFE_DATABASE_INTEGER}),
      total_score = LEAST(total_score + ${run.score}, ${MAX_SAFE_DATABASE_INTEGER}),
      high_score = GREATEST(high_score, ${run.score}),
      highest_level = GREATEST(highest_level, ${run.level}),
      total_duration_ms = LEAST(
        total_duration_ms + ${run.durationMs},
        ${MAX_SAFE_DATABASE_INTEGER}
      ),
      stats_revision = LEAST(stats_revision + 1, ${MAX_SAFE_DATABASE_INTEGER}),
      profile_schema_version = GREATEST(profile_schema_version, 2),
      updated_at = NOW()
    WHERE id = ${playerId}
  `;

  await sql`
    INSERT INTO game_player_totals (
      player_id, enemies_destroyed, bosses_defeated, shots_fired, shots_hit,
      longest_combo, powerups_collected, longest_run_ms, wins, arduino_runs,
      best_accuracy_permille, updated_at
    ) VALUES (
      ${playerId}, ${run.enemiesDestroyed}, ${run.bossesDefeated},
      ${run.shotsFired}, ${run.shotsHit}, ${run.longestCombo},
      ${run.powerupsCollected}, ${run.durationMs}, ${run.won ? 1 : 0},
      ${run.inputKind === "arduino" || run.inputKind === "mixed" ? 1 : 0},
      ${run.shotsFired >= 10 ? Math.floor((run.shotsHit * 1000) / run.shotsFired) : 0},
      NOW()
    )
    ON CONFLICT (player_id) DO UPDATE SET
      enemies_destroyed = LEAST(
        game_player_totals.enemies_destroyed + EXCLUDED.enemies_destroyed,
        ${MAX_SAFE_DATABASE_INTEGER}
      ),
      bosses_defeated = LEAST(
        game_player_totals.bosses_defeated + EXCLUDED.bosses_defeated,
        ${MAX_SAFE_DATABASE_INTEGER}
      ),
      shots_fired = LEAST(
        game_player_totals.shots_fired + EXCLUDED.shots_fired,
        ${MAX_SAFE_DATABASE_INTEGER}
      ),
      shots_hit = LEAST(
        game_player_totals.shots_hit + EXCLUDED.shots_hit,
        ${MAX_SAFE_DATABASE_INTEGER}
      ),
      longest_combo = GREATEST(
        game_player_totals.longest_combo, EXCLUDED.longest_combo
      ),
      powerups_collected = LEAST(
        game_player_totals.powerups_collected + EXCLUDED.powerups_collected,
        ${MAX_SAFE_DATABASE_INTEGER}
      ),
      longest_run_ms = GREATEST(
        game_player_totals.longest_run_ms, EXCLUDED.longest_run_ms
      ),
      wins = LEAST(
        game_player_totals.wins + EXCLUDED.wins,
        ${MAX_SAFE_DATABASE_INTEGER}
      ),
      arduino_runs = LEAST(
        game_player_totals.arduino_runs + EXCLUDED.arduino_runs,
        ${MAX_SAFE_DATABASE_INTEGER}
      ),
      best_accuracy_permille = GREATEST(
        game_player_totals.best_accuracy_permille,
        EXCLUDED.best_accuracy_permille
      ),
      updated_at = NOW()
  `;

  await sql`
    INSERT INTO game_player_mode_stats (
      player_id, mode_id, difficulty_id, games_played, total_score, high_score,
      highest_wave, enemies_destroyed, bosses_defeated, total_duration_ms,
      wins, updated_at
    ) VALUES (
      ${playerId}, ${run.modeId}, ${run.difficultyId}, 1, ${run.score},
      ${run.score}, ${run.highestWave}, ${run.enemiesDestroyed},
      ${run.bossesDefeated}, ${run.durationMs}, ${run.won ? 1 : 0}, NOW()
    )
    ON CONFLICT (player_id, mode_id, difficulty_id) DO UPDATE SET
      games_played = LEAST(
        game_player_mode_stats.games_played + 1,
        ${MAX_SAFE_DATABASE_INTEGER}
      ),
      total_score = LEAST(
        game_player_mode_stats.total_score + EXCLUDED.total_score,
        ${MAX_SAFE_DATABASE_INTEGER}
      ),
      high_score = GREATEST(game_player_mode_stats.high_score, EXCLUDED.high_score),
      highest_wave = GREATEST(
        game_player_mode_stats.highest_wave, EXCLUDED.highest_wave
      ),
      enemies_destroyed = LEAST(
        game_player_mode_stats.enemies_destroyed + EXCLUDED.enemies_destroyed,
        ${MAX_SAFE_DATABASE_INTEGER}
      ),
      bosses_defeated = LEAST(
        game_player_mode_stats.bosses_defeated + EXCLUDED.bosses_defeated,
        ${MAX_SAFE_DATABASE_INTEGER}
      ),
      total_duration_ms = LEAST(
        game_player_mode_stats.total_duration_ms + EXCLUDED.total_duration_ms,
        ${MAX_SAFE_DATABASE_INTEGER}
      ),
      wins = LEAST(
        game_player_mode_stats.wins + EXCLUDED.wins,
        ${MAX_SAFE_DATABASE_INTEGER}
      ),
      updated_at = NOW()
  `;

  if (run.powers.length > 0) {
    const playerPowerRows = run.powers.map((power) => ({
      player_id: playerId,
      power_id: power.powerId,
      collected_count: power.collectedCount,
      activated_count: power.activatedCount,
      updated_at: new Date(),
    }));
    await sql`
      INSERT INTO game_player_power_stats (
        player_id, power_id, collected_count, activated_count, updated_at
      ) ${sql(
        playerPowerRows,
        "player_id",
        "power_id",
        "collected_count",
        "activated_count",
        "updated_at"
      )}
      ON CONFLICT (player_id, power_id) DO UPDATE SET
        collected_count = LEAST(
          game_player_power_stats.collected_count + EXCLUDED.collected_count,
          ${MAX_SAFE_DATABASE_INTEGER}
        ),
        activated_count = LEAST(
          game_player_power_stats.activated_count + EXCLUDED.activated_count,
          ${MAX_SAFE_DATABASE_INTEGER}
        ),
        updated_at = EXCLUDED.updated_at
    `;
  }

  return {
    duplicateLegacyRun: false,
    newlyUnlocked: await updateAchievements(sql, playerId, run),
  };
}

async function applySettingsEvent(
  sql: SqlClient,
  playerId: number,
  event: Extract<ValidatedGameSyncEvent, { kind: "settings.updated" }>,
) {
  await sql`
    INSERT INTO game_player_settings (player_id)
    VALUES (${playerId})
    ON CONFLICT (player_id) DO NOTHING
  `;
  const patch = event.payload.settings;
  const rows = resultRows<Record<string, unknown>>(await sql`
    UPDATE game_player_settings
    SET
      music_volume = COALESCE(${patch.musicVolume ?? null}, music_volume),
      effects_volume = COALESCE(${patch.effectsVolume ?? null}, effects_volume),
      screen_shake = COALESCE(${patch.screenShake ?? null}, screen_shake),
      reduced_motion = COALESCE(${patch.reducedMotion ?? null}, reduced_motion),
      revision = revision + 1,
      updated_at = NOW()
    WHERE player_id = ${playerId} AND revision = ${event.payload.baseRevision}
    RETURNING revision
  `);
  if (!rows[0]) {
    throw new SyncEventError(
      409,
      "SETTINGS_CONFLICT",
      "Settings changed on another device. Refresh and retry.",
    );
  }
  // Same one-way promotion as applyRunSummary: a settings change must never
  // demote an account-only profile out of game_players_reachable_check.
  await sql`
    UPDATE game_players
    SET
      stats_revision = LEAST(stats_revision + 1, ${MAX_SAFE_DATABASE_INTEGER}),
      profile_schema_version = GREATEST(profile_schema_version, 2),
      updated_at = NOW()
    WHERE id = ${playerId}
  `;
}

async function applySyncEvent(
  sql: SqlClient,
  playerId: number,
  event: ValidatedGameSyncEvent,
): Promise<GameSyncResult> {
  const payloadHash = syncPayloadHash(event);
  return sql.begin(async (transaction) => {
    const tx = transaction as unknown as SqlClient;
    const playerRows = resultRows<Record<string, unknown>>(await tx`
      SELECT id FROM game_players
      WHERE id = ${playerId}
      FOR UPDATE
    `);
    if (!playerRows[0]) {
      throw new SyncEventError(404, "PROFILE_NOT_FOUND", "Profile was not found.");
    }
    const existingEvents = resultRows<Record<string, unknown>>(await tx`
      SELECT id, event_type AS "eventType", event_version AS "eventVersion",
        payload_sha256 AS "payloadHash"
      FROM game_sync_events
      WHERE player_id = ${playerId} AND event_id = ${event.eventId}
    `);
    const existing = existingEvents[0];
    if (existing) {
      if (
        databaseString(existing.eventType) !== event.kind ||
        databaseInteger(existing.eventVersion) !== event.version ||
        databaseString(existing.payloadHash).trim() !== payloadHash
      ) {
        throw new SyncEventError(
          409,
          "EVENT_ID_REUSED",
          "A sync event ID was reused with different data.",
        );
      }
      return {
        eventId: event.eventId,
        status: "duplicate",
        unlockedAchievementIds: [],
      };
    }

    const insertedEvents = resultRows<Record<string, unknown>>(await tx`
      INSERT INTO game_sync_events (
        player_id, event_id, event_type, event_version, payload_sha256
      ) VALUES (
        ${playerId}, ${event.eventId}, ${event.kind}, ${event.version},
        ${payloadHash}
      )
      RETURNING id
    `);
    const syncEventId = databaseInteger(insertedEvents[0]?.id);
    let unlockedAchievementIds: GameAchievementId[] = [];
    let status: GameSyncResult["status"] = "applied";
    if (event.kind === "run.completed") {
      const applied = await applyRunSummary(tx, playerId, syncEventId, event.payload);
      unlockedAchievementIds = applied.newlyUnlocked;
      if (applied.duplicateLegacyRun) status = "duplicate";
    } else {
      await applySettingsEvent(tx, playerId, event);
    }
    return { eventId: event.eventId, status, unlockedAchievementIds };
  });
}

async function progressionResponse(
  sql: SqlClient,
  playerId: number,
  results: GameSyncResult[],
): Promise<Response> {
  const snapshot = await selectPlayerSnapshot(sql, playerId);
  if (!snapshot) {
    return errorResponse(404, "PROFILE_NOT_FOUND", "Profile was not found.");
  }
  return jsonResponse({
    profile: snapshot.profile,
    progression: snapshot.progression,
    profilePublicId: snapshot.publicId,
    results,
  } satisfies SyncResponse);
}

function isAccountLinkUniqueError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const databaseError = error as DatabaseError;
  const constraint =
    typeof databaseError.constraint === "string"
      ? databaseError.constraint
      : typeof databaseError.constraint_name === "string"
        ? databaseError.constraint_name
        : "";
  return (
    databaseError.code === "23505" && constraint.includes("game_account_links")
  );
}

// Bearer resolution: the account link is the only route to a profile now that
// access codes are retired, so every bearer action starts here.
async function resolveLinkedPlayerId(
  sql: SqlClient,
  authUserId: string,
): Promise<number | null> {
  const rows = resultRows<Record<string, unknown>>(await sql`
    SELECT player.id
    FROM game_account_links AS link
    INNER JOIN game_players AS player ON player.id = link.player_id
    WHERE link.auth_user_id = ${authUserId}
    LIMIT 1
  `);
  return rows[0] ? databaseInteger(rows[0].id) : null;
}

// Audited HIGH: `create` and `rename` establish or change the identity, so a
// token whose session has been revoked (or that carries no session at all) must
// not pass. The check runs inside the surrounding transaction.
async function assertSessionActive(tx: SqlClient, auth: VerifiedAuth) {
  const revoked = new SyncEventError(
    401,
    "AUTH_SESSION_REVOKED",
    "The signed-in session is no longer active.",
  );
  if (!auth.sessionId || !UUID_PATTERN.test(auth.sessionId)) throw revoked;
  const rows = resultRows<Record<string, unknown>>(await tx`
    SELECT 1 AS active
    FROM auth.sessions
    WHERE id = ${auth.sessionId} AND user_id = ${auth.userId}
    LIMIT 1
  `);
  if (!rows[0]) throw revoked;
}

// Builds the account-profile response from an already-resolved player. The
// create path calls it inside its own transaction, so it reads through the
// caller's client instead of opening the read-only snapshot `session` uses.
async function accountProfileResponse(
  sql: SqlClient,
  playerId: number,
): Promise<Response> {
  const record = await selectPlayerRecord(sql, playerId);
  if (!record) {
    return errorResponse(404, "PROFILE_NOT_FOUND", "Profile was not found.");
  }
  return jsonResponse({
    profile: record.profile,
    progression: await getPlayerProgression(sql, playerId, record.statsRevision),
    profilePublicId: record.publicId,
    accountLinked: true,
  } satisfies ProfileResponse);
}

// Account-only create. The profile row carries no access code at all, so
// profile_schema_version 3 is what satisfies game_players_reachable_check, and
// the link row must land in the SAME transaction or the profile would be
// unreachable forever.
async function createAccountPlayer(
  sql: SqlClient,
  auth: VerifiedAuth,
  requestedNickname: string,
  language: GameStatsLanguage,
): Promise<Response> {
  const hasRequestedNickname = requestedNickname.length > 0;
  // A generated nickname may collide, so it gets one retry. A nickname the
  // player chose is reported back as 409 instead of silently replaced.
  const attempts = hasRequestedNickname ? 1 : 2;
  try {
    return await sql.begin(async (transaction) => {
      const tx = transaction as unknown as TransactionClient;
      await assertSessionActive(tx, auth);
      // A client retrying create after a lost response must get its own
      // profile back rather than a second one: the link is the idempotency key.
      const linkedPlayerId = await resolveLinkedPlayerId(tx, auth.userId);
      if (linkedPlayerId !== null) {
        return accountProfileResponse(tx, linkedPlayerId);
      }

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const insertNickname = hasRequestedNickname
          ? requestedNickname
          : generateRandomNickname(language);
        let rows: DatabaseRow[];
        try {
          // A savepoint keeps the transaction usable after a unique nickname
          // violation so the generated-nickname retry can proceed.
          rows = await tx.savepoint(async (savepointSql) =>
            rowsFromResult(await savepointSql`
              INSERT INTO game_players (
                access_code_hash, nickname, language, profile_schema_version
              )
              VALUES (
                NULL,
                ${insertNickname},
                ${language},
                ${ACCOUNT_PROFILE_SCHEMA_VERSION}
              )
              RETURNING
                id,
                public_id::text AS "publicId",
                nickname,
                LEAST(games_played, ${MAX_SAFE_DATABASE_INTEGER}) AS "gamesPlayed",
                LEAST(total_score, ${MAX_SAFE_DATABASE_INTEGER}) AS "totalScore",
                high_score AS "highScore",
                highest_level AS "highestLevel",
                LEAST(total_duration_ms, ${MAX_SAFE_DATABASE_INTEGER}) AS "totalDurationMs",
                updated_at AS "updatedAt",
                LEAST(stats_revision, ${MAX_SAFE_DATABASE_INTEGER}) AS "statsRevision"
            `),
          );
        } catch (error) {
          if (!isUniqueNicknameError(error)) throw error;
          // A nickname the player chose is reported back instead of being
          // silently replaced. A generated one is nobody's mistake, so it just
          // consumes an attempt and the exhausted loop answers with the
          // retryable 503 below.
          if (hasRequestedNickname) {
            return errorResponse(
              409,
              "NICKNAME_TAKEN",
              "Nickname is already in use.",
            );
          }
          continue;
        }
        const playerId = databaseInteger(rows[0].id);
        await tx`
          INSERT INTO game_account_links (player_id, auth_user_id, link_method)
          VALUES (${playerId}, ${auth.userId}, 'create')
        `;
        return jsonResponse({
          profile: playerFromRow(rows[0]),
          progression: await getPlayerProgression(
            tx,
            playerId,
            databaseInteger(rows[0].statsRevision),
          ),
          profilePublicId: databaseString(rows[0].publicId),
          accountLinked: true,
        } satisfies ProfileResponse);
      }
      // Only a generated nickname can exhaust the loop, and a collision on
      // every draw is a transient allocation failure rather than bad input.
      return errorResponse(
        503,
        "RANDOM_NICKNAME_UNAVAILABLE",
        "A random nickname could not be allocated. Please try again.",
      );
    });
  } catch (error) {
    if (isAccountLinkUniqueError(error)) {
      // A concurrent create for the same account committed first. The violation
      // proves its link exists, so return that profile instead of a duplicate.
      const racedPlayerId = await resolveLinkedPlayerId(sql, auth.userId);
      if (racedPlayerId !== null) {
        return accountProfileResponse(sql, racedPlayerId);
      }
    }
    if (error instanceof SyncEventError) {
      return errorResponse(error.status, error.code, error.message);
    }
    throw error;
  }
}


async function readLimitedBody(request: Request) {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytesRead += chunk.value.byteLength;
    if (bytesRead > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }

  return text + decoder.decode();
}

async function readJsonBody(
  request: Request,
): Promise<{ response: Response } | { body: Record<string, unknown> }> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return {
      response: errorResponse(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Content-Type must be application/json.",
      ),
    };
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return {
      response: errorResponse(413, "REQUEST_TOO_LARGE", "Request body is too large."),
    };
  }

  let text: string | null;
  try {
    text = await readLimitedBody(request);
  } catch {
    return {
      response: errorResponse(400, "INVALID_REQUEST", "Request body could not be read."),
    };
  }
  if (text === null) {
    return {
      response: errorResponse(413, "REQUEST_TOO_LARGE", "Request body is too large."),
    };
  }

  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return {
        response: errorResponse(400, "INVALID_REQUEST", "JSON body must be an object."),
      };
    }
    return { body: body as Record<string, unknown> };
  } catch {
    return {
      response: errorResponse(400, "INVALID_JSON", "Request body is not valid JSON."),
    };
  }
}

// Resolves the profile a mutation runs against. An account with no link has no
// profile yet, so the client is told to call `create`.
async function resolvePlayerId(
  sql: SqlClient,
  auth: VerifiedAuth,
): Promise<number | Response> {
  const playerId = await resolveLinkedPlayerId(sql, auth.userId);
  return (
    playerId ??
    errorResponse(
      404,
      "AUTH_NOT_LINKED",
      "This account is not linked to a profile.",
    )
  );
}

async function handlePost(request: Request, sql: SqlClient): Promise<Response> {
  const parsed = await readJsonBody(request);
  if ("response" in parsed) return parsed.response;
  const body = parsed.body;

  // Identity-looking fields are stripped and ignored — never a hard failure,
  // because rejecting them outright would freeze queued offline sync events.
  delete body.userId;
  delete body.email;
  delete body.authUserId;
  delete body.sub;

  if (
    typeof body.action !== "string" ||
    !(GAME_STATS_ACTIONS as readonly string[]).includes(body.action)
  ) {
    return errorResponse(400, "INVALID_ACTION", "A valid action is required.");
  }
  const action = body.action as GameStatsAction;

  // The token is parsed before the matrix runs, so a header that carries no
  // usable Bearer token (empty, Basic, garbage) counts as no credential and is
  // reported as AUTH_TOKEN_MISSING instead of reaching verification.
  const bearerToken = extractBearerToken(
    request.headers.get("authorization") ?? "",
  );
  // An explicit null is JSON's way of saying "no code", so it passes; any other
  // value is a retired credential and is refused rather than silently ignored.
  const hasAccessCode =
    body.accessCode !== undefined && body.accessCode !== null;
  const credentials = evaluateCredentialMatrix(
    action,
    hasAccessCode,
    bearerToken !== null,
  );
  if (!credentials.ok) {
    return errorResponse(credentials.status, credentials.code, credentials.error);
  }

  // Bearer verification runs before any SQL touches the database.
  if (!bearerToken) {
    // Unreachable: the matrix only succeeds once a token parsed.
    return errorResponse(
      401,
      "AUTH_TOKEN_MISSING",
      "A bearer token is required for this action.",
    );
  }
  const verified = await verifySupabaseToken(bearerToken);
  if (!verified.ok) {
    return errorResponse(verified.status, verified.code, verified.error);
  }
  const auth = verified.auth;

  switch (action) {
    case "create": {
      const language = validateLanguage(body.language);
      if (!language.ok) {
        return errorResponse(400, "INVALID_LANGUAGE", language.error);
      }
      const nickname = validateNickname(body.nickname ?? "", { allowBlank: true });
      if (!nickname.ok) {
        return errorResponse(400, "INVALID_NICKNAME", nickname.error);
      }
      // An account-only profile is written with profile_schema_version 3 and is
      // read back with its progression, so 0002 must already be in place.
      if (!(await hasProgressionSchema(sql))) {
        return errorResponse(
          503,
          "SCHEMA_MIGRATION_REQUIRED",
          "Game progression is queued until the database migration is applied.",
        );
      }
      const rateLimited = await enforceMutationRateLimits(
        request,
        sql,
        "create",
        auth.userId,
      );
      if (rateLimited) return rateLimited;
      return createAccountPlayer(sql, auth, nickname.value, language.value);
    }

    case "rename": {
      const nickname = validateNickname(body.nickname);
      if (!nickname.ok) {
        return errorResponse(400, "INVALID_NICKNAME", nickname.error);
      }
      const playerId = await resolvePlayerId(sql, auth);
      if (typeof playerId !== "number") return playerId;
      const rateLimited = await enforceMutationRateLimits(
        request,
        sql,
        "rename",
        auth.userId,
      );
      if (rateLimited) return rateLimited;
      return renamePlayer(sql, auth, playerId, nickname.value);
    }

    case "record": {
      const run = validateRun(body);
      if (!run.ok) {
        return errorResponse(400, "INVALID_RUN", run.error);
      }
      const playerId = await resolvePlayerId(sql, auth);
      if (typeof playerId !== "number") return playerId;
      const rateLimited = await enforceMutationRateLimits(
        request,
        sql,
        "record",
        auth.userId,
      );
      if (rateLimited) return rateLimited;
      const summary = validateRunSummary(run.value);
      if (!summary.ok) {
        return errorResponse(400, "INVALID_RUN", summary.error);
      }
      if (!(await hasProgressionSchema(sql))) {
        return errorResponse(
          503,
          "SCHEMA_MIGRATION_REQUIRED",
          "Game progression is queued until the database migration is applied.",
        );
      }
      try {
        const result = await applySyncEvent(sql, playerId, {
          eventId: summary.value.runId,
          kind: "run.completed",
          version: 2,
          payload: summary.value,
        });
        const snapshot = await selectPlayerSnapshot(sql, playerId);
        if (!snapshot) {
          return errorResponse(404, "PROFILE_NOT_FOUND", "Profile was not found.");
        }
        return jsonResponse({
          profile: snapshot.profile,
          progression: snapshot.progression,
          recorded: result.status === "applied",
          profilePublicId: snapshot.publicId,
        } satisfies ProfileResponse);
      } catch (error) {
        const mapped = syncFailureResponse(error);
        if (mapped) {
          reportDatabaseError("Legacy run could not be applied", error);
          return mapped;
        }
        throw error;
      }
    }

    case "sync": {
      const events = validateGameSyncEvents(body.events);
      if (!events.ok) {
        return errorResponse(400, "INVALID_SYNC_EVENTS", events.error);
      }
      if (!(await hasProgressionSchema(sql))) {
        return errorResponse(
          503,
          "SCHEMA_MIGRATION_REQUIRED",
          "Game progression is queued until the database migration is applied.",
        );
      }
      const playerId = await resolvePlayerId(sql, auth);
      if (typeof playerId !== "number") return playerId;
      const rateLimited = await enforceMutationRateLimits(
        request,
        sql,
        "sync",
        auth.userId,
        events.value.length,
        events.value.filter((event) => event.kind === "run.completed").length,
      );
      if (rateLimited) return rateLimited;
      try {
        const results: GameSyncResult[] = [];
        for (const event of events.value) {
          results.push(await applySyncEvent(sql, playerId, event));
        }
        return progressionResponse(sql, playerId, results);
      } catch (error) {
        const mapped = syncFailureResponse(error);
        if (mapped) {
          reportDatabaseError("Sync event could not be applied", error);
          return mapped;
        }
        throw error;
      }
    }

    case "session": {
      const playerId = await resolvePlayerId(sql, auth);
      if (typeof playerId !== "number") return playerId;
      const snapshot = await selectPlayerSnapshot(sql, playerId);
      if (!snapshot) {
        return errorResponse(404, "PROFILE_NOT_FOUND", "Profile was not found.");
      }
      return jsonResponse({
        profile: snapshot.profile,
        progression: snapshot.progression,
        profilePublicId: snapshot.publicId,
        accountLinked: true,
      } satisfies ProfileResponse);
    }

    default:
      return errorResponse(400, "INVALID_ACTION", "A valid action is required.");
  }
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse(
      {
        code: "METHOD_NOT_ALLOWED",
        error: "Only GET and POST are allowed.",
      },
      405,
      { Allow: "GET, POST" },
    );
  }

  let sql: SqlClient | null;
  try {
    sql = await getDatabase();
  } catch (error) {
    reportDatabaseError("Game statistics database initialization failed", error);
    return errorResponse(
      503,
      "DATABASE_UNAVAILABLE",
      "Game statistics are temporarily unavailable.",
    );
  }

  if (!sql) {
    return errorResponse(
      503,
      "DATABASE_NOT_CONFIGURED",
      "Game statistics require SUPABASE_DATABASE_URL.",
    );
  }

  try {
    if (request.method === "GET") {
      return jsonResponse({ leaderboard: await getLeaderboard(sql) });
    }
    return await handlePost(request, sql);
  } catch (error) {
    reportDatabaseError("Game statistics request failed", error);
    return errorResponse(
      503,
      "DATABASE_UNAVAILABLE",
      "Game statistics are temporarily unavailable.",
    );
  }
}

// Vercel's Web runtime requires the direct object export; do not wrap this in
// the legacy Node request/response adapter.
// eslint-disable-next-line import/no-anonymous-default-export
export default {
  fetch(request: Request) {
    return handleRequest(request);
  },
};
