import { createHash, createHmac } from "node:crypto";

import postgres from "postgres";

import {
  formatAccessCode,
  generateRandomNickname,
  type GameStatsLanguage,
  type LeaderboardEntry,
  type PlayerStats,
  type ProfileResponse,
  validateAccessCode,
  validateLanguage,
  validateNickname,
  validateRun,
} from "../shared/gameStats.js";

const MAX_REQUEST_BYTES = 8_192;
const MAX_SAFE_DATABASE_INTEGER = Number.MAX_SAFE_INTEGER;
const LEADERBOARD_LIMIT = 25;
const MAX_RETAINED_RUNS_PER_PLAYER = 512;
const RATE_LIMIT_RETENTION_DAYS = 2;

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
} as const;

const JSON_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

type SqlClient = ReturnType<typeof postgres>;

type DatabaseRow = {
  nickname: unknown;
  gamesPlayed: unknown;
  totalScore: unknown;
  highScore: unknown;
  highestLevel: unknown;
  totalDurationMs: unknown;
  updatedAt: unknown;
  recorded?: unknown;
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
  | "profile_rename";

type RateLimitRule = {
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

async function hashAccessCode(accessCode: string) {
  return createHash("sha256").update(accessCode, "utf8").digest("hex");
}

async function pseudonymizeRateLimitScope(scope: string) {
  const databaseUrl = process.env.SUPABASE_DATABASE_URL?.trim();
  const secret = process.env.RATE_LIMIT_SECRET?.trim() || databaseUrl;
  if (!secret) {
    throw new Error("A rate-limit pseudonymization key is unavailable.");
  }

  return createHmac("sha256", secret).update(scope, "utf8").digest("hex");
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
  const allowedRows = rateLimitRows(await sql`
    WITH consumed AS (
      INSERT INTO game_rate_limits (
        scope_hash,
        bucket,
        window_started_at,
        request_count
      )
      VALUES (${rule.scopeHash}, ${rule.bucket}, NOW(), 1)
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
            THEN 1
          ELSE game_rate_limits.request_count + 1
        END
      WHERE
        game_rate_limits.window_started_at <=
          NOW() - make_interval(secs => ${rule.windowSeconds})
        OR game_rate_limits.request_count < ${rule.limit}
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

async function enforceMutationRateLimits(
  request: Request,
  sql: SqlClient,
  action: "create" | "record" | "rename",
  accessCodeHash: string,
) {
  await cleanExpiredRateLimits(sql);
  const [ipScopeHash, profileScopeHash] = await Promise.all([
    pseudonymizeRateLimitScope(clientAddressScope(request)),
    pseudonymizeRateLimitScope(`profile:${accessCodeHash}`),
  ]);
  const rules: RateLimitRule[] = [
    { ...RATE_LIMITS.ipWrite, scopeHash: ipScopeHash },
  ];

  if (action === "create") {
    rules.push({ ...RATE_LIMITS.ipCreate, scopeHash: ipScopeHash });
    rules.push({ ...RATE_LIMITS.profileRename, scopeHash: profileScopeHash });
  } else if (action === "record") {
    rules.push({ ...RATE_LIMITS.profileRecord, scopeHash: profileScopeHash });
  } else {
    rules.push({ ...RATE_LIMITS.profileRename, scopeHash: profileScopeHash });
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

function rowsFromResult(result: unknown): DatabaseRow[] {
  if (!Array.isArray(result)) {
    throw new Error("The database returned an invalid result.");
  }
  return result as DatabaseRow[];
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

async function selectPlayer(sql: SqlClient, accessCodeHash: string) {
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
    WHERE access_code_hash = ${accessCodeHash}
    LIMIT 1
  `);
  return rows[0] ? playerFromRow(rows[0]) : null;
}

async function createPlayer(
  sql: SqlClient,
  accessCodeHash: string,
  accessCode: string,
  requestedNickname: string,
  language: GameStatsLanguage,
) {
  const hasRequestedNickname = requestedNickname.length > 0;
  const attempts = hasRequestedNickname ? 1 : 6;

  if (!hasRequestedNickname) {
    const existingProfile = await selectPlayer(sql, accessCodeHash);
    if (existingProfile) {
      return jsonResponse({
        profile: existingProfile,
        accessCode: formatAccessCode(accessCode),
      } satisfies ProfileResponse);
    }
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const insertNickname = hasRequestedNickname
      ? requestedNickname
      : generateRandomNickname(language);

    try {
      const rows = rowsFromResult(await sql`
        INSERT INTO game_players (access_code_hash, nickname, language)
        VALUES (${accessCodeHash}, ${insertNickname}, ${language})
        ON CONFLICT (access_code_hash) DO UPDATE SET
          nickname = COALESCE(${hasRequestedNickname ? requestedNickname : null}, game_players.nickname),
          language = EXCLUDED.language,
          updated_at = CASE
            WHEN ${hasRequestedNickname} OR game_players.language <> EXCLUDED.language
              THEN NOW()
            ELSE game_players.updated_at
          END
        RETURNING
          nickname,
          LEAST(games_played, ${MAX_SAFE_DATABASE_INTEGER}) AS "gamesPlayed",
          LEAST(total_score, ${MAX_SAFE_DATABASE_INTEGER}) AS "totalScore",
          high_score AS "highScore",
          highest_level AS "highestLevel",
          LEAST(total_duration_ms, ${MAX_SAFE_DATABASE_INTEGER}) AS "totalDurationMs",
          updated_at AS "updatedAt"
      `);

      return jsonResponse({
        profile: playerFromRow(rows[0]),
        accessCode: formatAccessCode(accessCode),
      } satisfies ProfileResponse);
    } catch (error) {
      if (isUniqueNicknameError(error) && attempt + 1 < attempts) continue;
      if (isUniqueNicknameError(error)) {
        return errorResponse(409, "NICKNAME_TAKEN", "Nickname is already in use.");
      }
      throw error;
    }
  }

  return errorResponse(
    503,
    "RANDOM_NICKNAME_UNAVAILABLE",
    "A random nickname could not be allocated. Please try again.",
  );
}

async function renamePlayer(
  sql: SqlClient,
  accessCodeHash: string,
  nickname: string,
) {
  try {
    const rows = rowsFromResult(await sql`
      UPDATE game_players
      SET nickname = ${nickname}, updated_at = NOW()
      WHERE access_code_hash = ${accessCodeHash}
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
    return jsonResponse({ profile: playerFromRow(rows[0]) } satisfies ProfileResponse);
  } catch (error) {
    if (isUniqueNicknameError(error)) {
      return errorResponse(409, "NICKNAME_TAKEN", "Nickname is already in use.");
    }
    throw error;
  }
}

async function pruneRetainedRuns(sql: SqlClient, accessCodeHash: string) {
  await sql`
    DELETE FROM game_runs
    WHERE player_id = (
      SELECT id FROM game_players WHERE access_code_hash = ${accessCodeHash}
    )
    AND id NOT IN (
      SELECT run.id
      FROM game_runs AS run
      INNER JOIN game_players AS player ON player.id = run.player_id
      WHERE player.access_code_hash = ${accessCodeHash}
      ORDER BY run.recorded_at DESC, run.id DESC
      LIMIT ${MAX_RETAINED_RUNS_PER_PLAYER}
    )
  `;
}

async function recordRun(
  sql: SqlClient,
  accessCodeHash: string,
  run: { runId: string; score: number; level: number; durationMs: number },
) {
  const rows = rowsFromResult(await sql`
    WITH selected_player AS (
      SELECT id
      FROM game_players
      WHERE access_code_hash = ${accessCodeHash}
    ), inserted_run AS (
      INSERT INTO game_runs (player_id, run_id, score, level, duration_ms)
      SELECT id, ${run.runId}, ${run.score}, ${run.level}, ${run.durationMs}
      FROM selected_player
      WHERE TRUE
      ON CONFLICT (player_id, run_id) DO NOTHING
      RETURNING player_id
    ), updated_player AS (
      UPDATE game_players AS player
      SET
        games_played = LEAST(player.games_played + 1, ${MAX_SAFE_DATABASE_INTEGER}),
        total_score = LEAST(player.total_score + ${run.score}, ${MAX_SAFE_DATABASE_INTEGER}),
        high_score = GREATEST(player.high_score, ${run.score}),
        highest_level = GREATEST(player.highest_level, ${run.level}),
        total_duration_ms = LEAST(
          player.total_duration_ms + ${run.durationMs},
          ${MAX_SAFE_DATABASE_INTEGER}
        ),
        updated_at = NOW()
      FROM inserted_run
      WHERE player.id = inserted_run.player_id
      RETURNING
        player.nickname,
        LEAST(player.games_played, ${MAX_SAFE_DATABASE_INTEGER}) AS "gamesPlayed",
        LEAST(player.total_score, ${MAX_SAFE_DATABASE_INTEGER}) AS "totalScore",
        player.high_score AS "highScore",
        player.highest_level AS "highestLevel",
        LEAST(player.total_duration_ms, ${MAX_SAFE_DATABASE_INTEGER}) AS "totalDurationMs",
        player.updated_at AS "updatedAt"
    )
    SELECT
      nickname,
      "gamesPlayed",
      "totalScore",
      "highScore",
      "highestLevel",
      "totalDurationMs",
      "updatedAt",
      TRUE AS recorded
    FROM updated_player
    UNION ALL
    SELECT
      player.nickname,
      LEAST(player.games_played, ${MAX_SAFE_DATABASE_INTEGER}) AS "gamesPlayed",
      LEAST(player.total_score, ${MAX_SAFE_DATABASE_INTEGER}) AS "totalScore",
      player.high_score AS "highScore",
      player.highest_level AS "highestLevel",
      LEAST(player.total_duration_ms, ${MAX_SAFE_DATABASE_INTEGER}) AS "totalDurationMs",
      player.updated_at AS "updatedAt",
      FALSE AS recorded
    FROM game_players AS player
    INNER JOIN selected_player ON selected_player.id = player.id
    WHERE NOT EXISTS (SELECT 1 FROM inserted_run)
  `);

  if (!rows[0]) {
    return errorResponse(404, "PROFILE_NOT_FOUND", "Profile was not found.");
  }

  await pruneRetainedRuns(sql, accessCodeHash);

  if (rows[0].recorded !== true) {
    const currentProfile = await selectPlayer(sql, accessCodeHash);
    if (!currentProfile) {
      return errorResponse(404, "PROFILE_NOT_FOUND", "Profile was not found.");
    }
    return jsonResponse({
      profile: currentProfile,
      recorded: false,
    } satisfies ProfileResponse);
  }

  return jsonResponse({
    profile: playerFromRow(rows[0]),
    recorded: true,
  } satisfies ProfileResponse);
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

async function readJsonBody(request: Request) {
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

async function handlePost(request: Request, sql: SqlClient) {
  const parsed = await readJsonBody(request);
  if ("response" in parsed) return parsed.response;
  const body = parsed.body;

  if (typeof body.action !== "string") {
    return errorResponse(400, "INVALID_ACTION", "A valid action is required.");
  }

  const accessCode = validateAccessCode(body.accessCode);
  if (!accessCode.ok) {
    return errorResponse(400, "INVALID_ACCESS_CODE", accessCode.error);
  }
  const accessCodeHash = await hashAccessCode(accessCode.value);

  switch (body.action) {
    case "create": {
      const language = validateLanguage(body.language);
      if (!language.ok) {
        return errorResponse(400, "INVALID_LANGUAGE", language.error);
      }
      const nickname = validateNickname(body.nickname ?? "", { allowBlank: true });
      if (!nickname.ok) {
        return errorResponse(400, "INVALID_NICKNAME", nickname.error);
      }
      const rateLimited = await enforceMutationRateLimits(
        request,
        sql,
        "create",
        accessCodeHash,
      );
      if (rateLimited) return rateLimited;
      return createPlayer(
        sql,
        accessCodeHash,
        accessCode.value,
        nickname.value,
        language.value,
      );
    }

    case "connect": {
      const profile = await selectPlayer(sql, accessCodeHash);
      return profile
        ? jsonResponse({ profile } satisfies ProfileResponse)
        : errorResponse(404, "PROFILE_NOT_FOUND", "Profile was not found.");
    }

    case "rename": {
      const nickname = validateNickname(body.nickname);
      if (!nickname.ok) {
        return errorResponse(400, "INVALID_NICKNAME", nickname.error);
      }
      const rateLimited = await enforceMutationRateLimits(
        request,
        sql,
        "rename",
        accessCodeHash,
      );
      if (rateLimited) return rateLimited;
      return renamePlayer(sql, accessCodeHash, nickname.value);
    }

    case "record": {
      const run = validateRun(body);
      if (!run.ok) {
        return errorResponse(400, "INVALID_RUN", run.error);
      }
      const rateLimited = await enforceMutationRateLimits(
        request,
        sql,
        "record",
        accessCodeHash,
      );
      if (rateLimited) return rateLimited;
      return recordRun(sql, accessCodeHash, run.value);
    }

    default:
      return errorResponse(400, "INVALID_ACTION", "A valid action is required.");
  }
}

async function handleRequest(request: Request) {
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

export default function statsFunction(request: Request) {
  return handleRequest(request);
}
