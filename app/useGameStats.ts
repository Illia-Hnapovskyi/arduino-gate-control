"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GAME_ACHIEVEMENTS,
  GAME_STATS_API_PATH,
  MAX_GAME_SYNC_EVENTS,
  type ErrorResponse,
  type GameRunSummaryInput,
  type GameStatsLanguage,
  type GameStatsRequest,
  type GameSyncEvent,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type PlayerProgression,
  type PlayerStats,
  type ProfileResponse,
  type RunCompletedSyncEvent,
  type SyncResponse,
  type ValidatedRun,
  type ValidatedRunSummary,
  generateAccessCode,
  generateRandomNickname,
  normalizeAccessCode,
  validateAccessCode,
  validateNickname,
  validateRun,
  validateGameSyncEvent,
  validateGameSyncResults,
  validatePlayerProgression,
  validateRunSummary,
} from "../shared/gameStats.ts";

const LEGACY_STORAGE_KEY = "arduino-gate-game-stats:v1";
const STORAGE_KEY = "arduino-gate-game-stats:v2";
const STORAGE_VERSION = 2;
const MAX_REMEMBERED_RUN_IDS = 100;
const REQUEST_TIMEOUT_MS = 12_000;

export type GameStatsSyncStatus =
  | "loading"
  | "local-only"
  | "syncing"
  | "synced"
  | "offline"
  | "error";

export type GameStatsOperation =
  | "create"
  | "connect"
  | "rename"
  | "record"
  | "sync"
  | "leaderboard"
  | "storage";

export type GameStatsError = {
  code: string;
  message: string;
  operation: GameStatsOperation;
};

export type GameStatsProfile = PlayerStats & {
  accessCode: string;
};

export type GameRunInput = GameRunSummaryInput;

type StoredProfile = {
  accessCode: string;
  pendingNickname: string | null;
  remoteConfirmed: boolean;
  stats: PlayerStats;
  progression: PlayerProgression | null;
};

export type StoredGameStatsV2 = {
  knownEventIds: string[];
  pendingEvents: RunCompletedSyncEvent[];
  profile: StoredProfile | null;
  version: typeof STORAGE_VERSION;
};

type HookSnapshot = {
  leaderboard: LeaderboardEntry[];
  pendingCount: number;
  profile: GameStatsProfile | null;
  profileOwnerId: string | null;
  progression: PlayerProgression | null;
};

export type GameRunRecordResult =
  | "queued"
  | "duplicate"
  | "invalid"
  | "profile-mismatch"
  | "storage-error";

export type UseGameStatsResult = HookSnapshot & {
  status: GameStatsSyncStatus;
  error: GameStatsError | null;
  createProfile: (nickname?: string) => Promise<GameStatsProfile>;
  connectProfile: (accessCode: string) => Promise<GameStatsProfile>;
  renameProfile: (nickname: string) => Promise<void>;
  forgetProfile: () => void;
  retrySync: () => Promise<void>;
  recordRun: (
    run: GameRunInput,
    expectedProfileOwnerId?: string | null,
  ) => GameRunRecordResult;
};

export type UseGameStatsOptions = {
  language: GameStatsLanguage;
};

export class GameStatsClientError extends Error {
  readonly code: string;
  readonly operation: GameStatsOperation;

  constructor(operation: GameStatsOperation, code: string, message: string) {
    super(message);
    this.name = "GameStatsClientError";
    this.operation = operation;
    this.code = code;
  }
}

function emptyStoredGameStats(): StoredGameStatsV2 {
  return {
    knownEventIds: [],
    pendingEvents: [],
    profile: null,
    version: STORAGE_VERSION,
  };
}

export function profileOwnerIdFromAccessCode(accessCode: string) {
  const normalized = normalizeAccessCode(accessCode);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < normalized.length; index++) {
    const code = normalized.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ (code + index * 17), 0x85ebca6b) >>> 0;
  }
  return `profile_${left.toString(16).padStart(8, "0")}${right
    .toString(16)
    .padStart(8, "0")}`;
}

function emptyPlayerStats(nickname: string): PlayerStats {
  return {
    nickname,
    gamesPlayed: 0,
    totalScore: 0,
    highScore: 0,
    highestLevel: 0,
    totalDurationMs: 0,
    updatedAt: new Date().toISOString(),
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPlayerStats(value: unknown): value is PlayerStats {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stats = value as Partial<PlayerStats>;
  return (
    validateNickname(stats.nickname).ok &&
    isNonNegativeSafeInteger(stats.gamesPlayed) &&
    isNonNegativeSafeInteger(stats.totalScore) &&
    isNonNegativeSafeInteger(stats.highScore) &&
    (stats.highScore as number) <= 100_000_000 &&
    isNonNegativeSafeInteger(stats.highestLevel) &&
    (stats.highestLevel as number) <= 9 &&
    isNonNegativeSafeInteger(stats.totalDurationMs) &&
    typeof stats.updatedAt === "string" &&
    !Number.isNaN(new Date(stats.updatedAt).getTime())
  );
}

function isLeaderboardEntry(value: unknown): value is LeaderboardEntry {
  return (
    isPlayerStats(value) &&
    isNonNegativeSafeInteger((value as Partial<LeaderboardEntry>).rank) &&
    (value as LeaderboardEntry).rank > 0
  );
}

function isPlayerProgression(value: unknown): value is PlayerProgression {
  return validatePlayerProgression(value).ok;
}

export function sanitizeStoredGameStatsV2(value: unknown): StoredGameStatsV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyStoredGameStats();
  }

  const candidate = value as Partial<StoredGameStatsV2>;
  if (candidate.version !== STORAGE_VERSION) return emptyStoredGameStats();

  let profile: StoredProfile | null = null;
  if (
    candidate.profile &&
    typeof candidate.profile === "object" &&
    !Array.isArray(candidate.profile)
  ) {
    const rawProfile = candidate.profile as Partial<StoredProfile>;
    const accessCode = validateAccessCode(rawProfile.accessCode);
    const pendingNickname =
      rawProfile.pendingNickname === null
        ? null
        : validateNickname(rawProfile.pendingNickname);

    if (
      accessCode.ok &&
      isPlayerStats(rawProfile.stats) &&
      typeof rawProfile.remoteConfirmed === "boolean" &&
      (pendingNickname === null || pendingNickname.ok)
    ) {
      const progression = validatePlayerProgression(rawProfile.progression);
      profile = {
        accessCode: accessCode.value,
        pendingNickname:
          pendingNickname === null ? null : pendingNickname.value,
        remoteConfirmed: rawProfile.remoteConfirmed,
        stats: rawProfile.stats,
        progression: progression.ok ? progression.value : null,
      };
    }
  }

  const pendingEvents = Array.isArray(candidate.pendingEvents)
    ? candidate.pendingEvents.flatMap((event) => {
        const result = validateGameSyncEvent(event);
        return result.ok && result.value.kind === "run.completed"
          ? [result.value]
          : [];
      })
    : [];
  const uniquePendingEvents = pendingEvents.filter(
    (event, index, events) =>
      events.findIndex(
        (candidateEvent) => candidateEvent.eventId === event.eventId,
      ) ===
      index,
  );
  const knownEventIds = Array.isArray(candidate.knownEventIds)
    ? candidate.knownEventIds.filter(
        (eventId): eventId is string =>
          typeof eventId === "string" &&
          validateRun({ runId: eventId, score: 0, level: 1, durationMs: 0 }).ok,
      )
    : [];

  return {
    knownEventIds: Array.from(
      new Set([
        ...knownEventIds,
        ...uniquePendingEvents.map((event) => event.eventId),
      ]),
    ).slice(-MAX_REMEMBERED_RUN_IDS),
    pendingEvents: profile ? uniquePendingEvents : [],
    profile,
    version: STORAGE_VERSION,
  };
}

type LegacyStoredProfile = Omit<StoredProfile, "progression">;
type LegacyStoredGameStats = {
  knownRunIds?: unknown;
  pendingRuns?: unknown;
  profile?: unknown;
  version?: unknown;
};

export function migrateStoredGameStatsV1(value: unknown): StoredGameStatsV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyStoredGameStats();
  }
  const candidate = value as LegacyStoredGameStats;
  if (candidate.version !== 1) return emptyStoredGameStats();

  let profile: StoredProfile | null = null;
  if (
    candidate.profile &&
    typeof candidate.profile === "object" &&
    !Array.isArray(candidate.profile)
  ) {
    const rawProfile = candidate.profile as Partial<LegacyStoredProfile>;
    const accessCode = validateAccessCode(rawProfile.accessCode);
    const pendingNickname =
      rawProfile.pendingNickname === null
        ? null
        : validateNickname(rawProfile.pendingNickname);
    if (
      accessCode.ok &&
      isPlayerStats(rawProfile.stats) &&
      typeof rawProfile.remoteConfirmed === "boolean" &&
      (pendingNickname === null || pendingNickname.ok)
    ) {
      profile = {
        accessCode: accessCode.value,
        pendingNickname:
          pendingNickname === null ? null : pendingNickname.value,
        remoteConfirmed: rawProfile.remoteConfirmed,
        stats: rawProfile.stats,
        progression: null,
      };
    }
  }

  const pendingEvents: RunCompletedSyncEvent[] = Array.isArray(
    candidate.pendingRuns,
  )
    ? candidate.pendingRuns.flatMap((run) => {
        const summary = validateRunSummary(run);
        return summary.ok
          ? [
              {
                eventId: summary.value.runId,
                kind: "run.completed" as const,
                version: 2 as const,
                payload: summary.value,
              },
            ]
          : [];
      })
    : [];
  const uniquePendingEvents = pendingEvents.filter(
    (event, index, events) =>
      events.findIndex((entry) => entry.eventId === event.eventId) === index,
  );
  const knownRunIds = Array.isArray(candidate.knownRunIds)
    ? candidate.knownRunIds.filter(
        (runId): runId is string =>
          typeof runId === "string" &&
          validateRun({ runId, score: 0, level: 1, durationMs: 0 }).ok,
      )
    : [];

  return {
    knownEventIds: Array.from(
      new Set([
        ...knownRunIds,
        ...uniquePendingEvents.map((event) => event.eventId),
      ]),
    ).slice(-MAX_REMEMBERED_RUN_IDS),
    pendingEvents: profile ? uniquePendingEvents : [],
    profile,
    version: STORAGE_VERSION,
  };
}

function readStoredGameStats() {
  if (typeof window === "undefined") return emptyStoredGameStats();
  let stored: string | null = null;
  let legacy: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
    legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return emptyStoredGameStats();
  }
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as unknown;
      const sanitized = sanitizeStoredGameStatsV2(parsed);
      const rawProfile =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as { profile?: unknown }).profile
          : undefined;
      if (sanitized.profile || rawProfile === null || !legacy) {
        return sanitized;
      }
      // A version-two object with a malformed non-null profile must not hide a
      // recoverable version-one profile and its pending runs.
    } catch {
      // Fall back to the retained v1 value if the new value was interrupted.
    }
  }
  if (!legacy) return emptyStoredGameStats();
  try {
    const migrated = migrateStoredGameStatsV1(JSON.parse(legacy) as unknown);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    } catch {
      // Keep the migrated in-memory profile and retry persistence later.
    }
    return migrated;
  } catch {
    return emptyStoredGameStats();
  }
}

function writeStoredGameStats(store: StoredGameStatsV2) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function toHookSnapshot(
  store: StoredGameStatsV2,
  leaderboard: LeaderboardEntry[],
): HookSnapshot {
  const profile = store.profile
    ? { ...store.profile.stats, accessCode: store.profile.accessCode }
    : null;
  return {
    leaderboard,
    pendingCount: store.pendingEvents.length,
    profile,
    profileOwnerId: store.profile
      ? profileOwnerIdFromAccessCode(store.profile.accessCode)
      : null,
    progression: store.profile
      ? (store.profile.progression ??
        addEventsToProgression(
          null,
          store.pendingEvents,
          store.profile.stats,
        ))
      : null,
  };
}

function addRunToStats(
  stats: PlayerStats,
  run: ValidatedRun,
  updatedAt = new Date().toISOString(),
): PlayerStats {
  return {
    ...stats,
    gamesPlayed: stats.gamesPlayed + 1,
    totalScore: stats.totalScore + run.score,
    highScore: Math.max(stats.highScore, run.score),
    highestLevel: Math.max(stats.highestLevel, run.level),
    totalDurationMs: stats.totalDurationMs + run.durationMs,
    updatedAt,
  };
}

function addEventsToStats(stats: PlayerStats, events: RunCompletedSyncEvent[]) {
  return events.reduce((current, event) => {
    const run = validateRunSummary(event.payload);
    return run.ok
      ? addRunToStats(
          current,
          run.value,
          run.value.clientEndedAt ?? current.updatedAt,
        )
      : current;
  }, stats);
}

function emptyProgression(): PlayerProgression {
  return {
    schemaVersion: 2,
    serverRevision: 0,
    totals: {
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
    },
    modes: [],
    powers: [],
    achievements: [],
    unlocks: [],
    settings: {
      revision: 0,
      musicVolume: 70,
      effectsVolume: 80,
      screenShake: true,
      reducedMotion: false,
    },
  };
}

function addRunToProgression(
  progression: PlayerProgression,
  run: ValidatedRunSummary,
  playerStats: PlayerStats,
): PlayerProgression {
  const runAccuracy =
    run.shotsFired >= 10
      ? Math.floor((run.shotsHit * 1000) / run.shotsFired)
      : 0;
  const totals = {
    enemiesDestroyed:
      progression.totals.enemiesDestroyed + run.enemiesDestroyed,
    bossesDefeated: progression.totals.bossesDefeated + run.bossesDefeated,
    shotsFired: progression.totals.shotsFired + run.shotsFired,
    shotsHit: progression.totals.shotsHit + run.shotsHit,
    longestCombo: Math.max(
      progression.totals.longestCombo,
      run.longestCombo,
    ),
    powerupsCollected:
      progression.totals.powerupsCollected + run.powerupsCollected,
    longestRunMs: Math.max(
      progression.totals.longestRunMs,
      run.durationMs,
    ),
    wins: progression.totals.wins + (run.won ? 1 : 0),
    arduinoRuns:
      progression.totals.arduinoRuns +
      (run.inputKind === "arduino" || run.inputKind === "mixed" ? 1 : 0),
    bestAccuracyPermille: Math.max(
      progression.totals.bestAccuracyPermille,
      runAccuracy,
    ),
  };

  const modeIndex = progression.modes.findIndex(
    (entry) =>
      entry.modeId === run.modeId &&
      entry.difficultyId === run.difficultyId,
  );
  const modes = [...progression.modes];
  const previousMode = modes[modeIndex];
  const nextMode = {
    modeId: run.modeId,
    difficultyId: run.difficultyId,
    gamesPlayed: (previousMode?.gamesPlayed ?? 0) + 1,
    totalScore: (previousMode?.totalScore ?? 0) + run.score,
    highScore: Math.max(previousMode?.highScore ?? 0, run.score),
    highestWave: Math.max(previousMode?.highestWave ?? 0, run.highestWave),
    enemiesDestroyed:
      (previousMode?.enemiesDestroyed ?? 0) + run.enemiesDestroyed,
    bossesDefeated:
      (previousMode?.bossesDefeated ?? 0) + run.bossesDefeated,
    totalDurationMs:
      (previousMode?.totalDurationMs ?? 0) + run.durationMs,
    wins: (previousMode?.wins ?? 0) + (run.won ? 1 : 0),
  };
  if (modeIndex >= 0) modes[modeIndex] = nextMode;
  else modes.push(nextMode);

  const powers = [...progression.powers];
  for (const power of run.powers) {
    const index = powers.findIndex((entry) => entry.powerId === power.powerId);
    const previous = powers[index];
    const next = {
      powerId: power.powerId,
      collectedCount:
        (previous?.collectedCount ?? 0) + power.collectedCount,
      activatedCount:
        (previous?.activatedCount ?? 0) + power.activatedCount,
    };
    if (index >= 0) powers[index] = next;
    else powers.push(next);
  }
  powers.sort((left, right) => left.powerId.localeCompare(right.powerId));

  const flawlessSector = run.sectors.some(
    (sector) => sector.completed && sector.livesLost === 0,
  );
  const progressValues = {
    first_run: playerStats.gamesPlayed,
    first_enemy: totals.enemiesDestroyed,
    first_boss: totals.bossesDefeated,
    survivor_5m: totals.longestRunMs,
    flawless_sector: flawlessSector ? 1 : 0,
    combo_25: totals.longestCombo,
    score_10000: playerStats.highScore,
    sharpshooter: totals.bestAccuracyPermille,
    arduino_pilot: totals.arduinoRuns,
    power_explorer: powers.filter((power) => power.activatedCount > 0).length,
    max_level: playerStats.highestLevel,
    veteran_10: playerStats.gamesPlayed,
  } as const;
  const achievements = [...progression.achievements];
  const unlocks = [...progression.unlocks];
  const now = run.clientEndedAt ?? playerStats.updatedAt;
  for (const definition of GAME_ACHIEVEMENTS) {
    const index = achievements.findIndex(
      (entry) => entry.achievementId === definition.id,
    );
    const previous = achievements[index];
    const progress = Math.max(
      previous?.progress ?? 0,
      progressValues[definition.id],
    );
    const unlockedAt =
      previous?.unlockedAt ?? (progress >= definition.target ? now : null);
    const next = {
      achievementId: definition.id,
      progress,
      unlockedAt,
    };
    if (index >= 0) achievements[index] = next;
    else achievements.push(next);
    const unlockId = `achievement:${definition.id}`;
    if (
      unlockedAt &&
      !unlocks.some((unlock) => unlock.unlockId === unlockId)
    ) {
      unlocks.push({ unlockId, unlockedAt });
    }
  }

  return { ...progression, totals, modes, powers, achievements, unlocks };
}

function addEventsToProgression(
  progression: PlayerProgression | null,
  events: RunCompletedSyncEvent[],
  resultingStats: PlayerStats,
) {
  return events.reduce((current, event) => {
    const run = validateRunSummary(event.payload);
    return run.ok
      ? addRunToProgression(current, run.value, resultingStats)
      : current;
  }, progression ?? emptyProgression());
}

export function mergeStoredGameStatsV2(
  current: StoredGameStatsV2,
  incoming: StoredGameStatsV2,
): StoredGameStatsV2 {
  if (!current.profile) return incoming;
  if (
    !incoming.profile ||
    incoming.profile.accessCode !== current.profile.accessCode
  ) {
    // A second tab must not replace or forget the profile that owns a running
    // game and its offline queue. Explicit profile changes remain local to the
    // tab where the player initiated them.
    return current;
  }

  const currentRevision = current.profile.progression?.serverRevision ?? 0;
  const incomingRevision = incoming.profile.progression?.serverRevision ?? 0;
  const currentUpdatedAt = Date.parse(current.profile.stats.updatedAt) || 0;
  const incomingUpdatedAt = Date.parse(incoming.profile.stats.updatedAt) || 0;
  const tieBreakerComparison =
    Math.sign(
      incoming.profile.stats.gamesPlayed - current.profile.stats.gamesPlayed,
    ) ||
    Math.sign(
      incoming.profile.stats.totalScore - current.profile.stats.totalScore,
    ) ||
    Math.sign(
      incoming.profile.stats.highScore - current.profile.stats.highScore,
    ) ||
    [...incoming.knownEventIds]
      .sort()
      .join(",")
      .localeCompare([...current.knownEventIds].sort().join(","));
  const incomingIsNewer =
    incomingRevision > currentRevision ||
    (incomingRevision === currentRevision &&
      (incomingUpdatedAt > currentUpdatedAt ||
        (incomingUpdatedAt === currentUpdatedAt && tieBreakerComparison > 0)));
  const base = incomingIsNewer ? incoming : current;
  const other = incomingIsNewer ? current : incoming;
  const baseProfile = base.profile as StoredProfile;
  const otherProfile = other.profile as StoredProfile;
  const baseKnownIds = new Set(base.knownEventIds);
  const missingEvents = other.pendingEvents.filter(
    (event) => !baseKnownIds.has(event.eventId),
  );
  const pendingEvents = [...base.pendingEvents, ...missingEvents]
    .filter(
      (event, index, events) =>
        events.findIndex((entry) => entry.eventId === event.eventId) === index,
    )
    .sort((left, right) => {
      const leftEndedAt = left.payload.clientEndedAt ?? "";
      const rightEndedAt = right.payload.clientEndedAt ?? "";
      return (
        leftEndedAt.localeCompare(rightEndedAt) ||
        left.eventId.localeCompare(right.eventId)
      );
    });
  const optimisticStats = {
    ...addEventsToStats(baseProfile.stats, missingEvents),
    updatedAt: new Date(Math.max(currentUpdatedAt, incomingUpdatedAt)).toISOString(),
  };
  const baseProgression =
    baseProfile.progression ??
    addEventsToProgression(
      null,
      base.pendingEvents,
      baseProfile.stats,
    );
  const optimisticProgression = addEventsToProgression(
    baseProgression,
    missingEvents,
    optimisticStats,
  );

  return {
    version: STORAGE_VERSION,
    knownEventIds: Array.from(
      new Set([
        ...base.knownEventIds,
        ...other.knownEventIds,
        ...pendingEvents.map((event) => event.eventId),
      ]),
    ).sort().slice(-MAX_REMEMBERED_RUN_IDS),
    pendingEvents,
    profile: {
      ...baseProfile,
      remoteConfirmed:
        baseProfile.remoteConfirmed || otherProfile.remoteConfirmed,
      stats: optimisticStats,
      progression: optimisticProgression,
    },
  };
}

export function shouldPersistMergedGameStats(
  current: StoredGameStatsV2,
  incoming: StoredGameStatsV2,
) {
  return Boolean(
    current.profile &&
    incoming.profile &&
    current.profile.accessCode === incoming.profile.accessCode,
  );
}

function asGameStatsError(
  error: unknown,
  fallbackOperation: GameStatsOperation,
): GameStatsError {
  if (error instanceof GameStatsClientError) {
    return {
      code: error.code,
      message: error.message,
      operation: error.operation,
    };
  }
  return {
    code: "network_error",
    message: error instanceof Error ? error.message : "Network request failed.",
    operation: fallbackOperation,
  };
}

function isOfflineError(error: unknown) {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  return (
    error instanceof TypeError ||
    (error instanceof GameStatsClientError && error.code === "network_error")
  );
}

async function readResponseBody(response: Response) {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

async function fetchGameStats(
  operation: GameStatsOperation,
  init: RequestInit,
) {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  try {
    return await fetch(GAME_STATS_API_PATH, {
      ...init,
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
  } catch (error) {
    throw new GameStatsClientError(
      operation,
      controller.signal.aborted ? "request_timeout" : "network_error",
      controller.signal.aborted
        ? "The statistics service took too long to respond."
        : error instanceof Error
          ? error.message
          : "Network request failed.",
    );
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function postProfile(request: GameStatsRequest): Promise<ProfileResponse> {
  const response = await fetchGameStats(request.action, {
    body: JSON.stringify(request),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  const body = await readResponseBody(response);
  if (!response.ok) {
    const apiError = (body ?? {}) as Partial<ErrorResponse>;
    throw new GameStatsClientError(
      request.action,
      typeof apiError.code === "string" ? apiError.code : "request_failed",
      typeof apiError.error === "string" ? apiError.error : "Request failed.",
    );
  }

  const result = body as Partial<ProfileResponse> | null;
  if (!result || !isPlayerStats(result.profile)) {
    throw new GameStatsClientError(
      request.action,
      "invalid_response",
      "The statistics service returned an invalid response.",
    );
  }
  let progression: PlayerProgression | undefined;
  if (result.progression !== undefined) {
    const validatedProgression = validatePlayerProgression(result.progression);
    if (!validatedProgression.ok) {
      throw new GameStatsClientError(
        request.action,
        "invalid_response",
        "The statistics service returned invalid progression data.",
      );
    }
    progression = validatedProgression.value;
  }
  let accessCode: string | undefined;
  if (result.accessCode !== undefined) {
    const validatedAccessCode = validateAccessCode(result.accessCode);
    if (!validatedAccessCode.ok) {
      throw new GameStatsClientError(
        request.action,
        "invalid_response",
        "The statistics service returned an invalid profile code.",
      );
    }
    accessCode = validatedAccessCode.value;
  }
  if (result.recorded !== undefined && typeof result.recorded !== "boolean") {
    throw new GameStatsClientError(
      request.action,
      "invalid_response",
      "The statistics service returned an invalid record status.",
    );
  }
  return {
    profile: result.profile,
    ...(accessCode ? { accessCode } : {}),
    ...(result.recorded === undefined ? {} : { recorded: result.recorded }),
    ...(progression ? { progression } : {}),
  };
}

async function postSync(
  accessCode: string,
  events: GameSyncEvent[],
): Promise<SyncResponse> {
  const result = (await postProfile({
    action: "sync",
    accessCode,
    events,
  })) as Partial<SyncResponse>;
  const results = validateGameSyncResults(result.results);
  const progression = validatePlayerProgression(result.progression);
  const expectedIds = events.map((event) => event.eventId).sort();
  const receivedIds = results.ok
    ? results.value.map((entry) => entry.eventId).sort()
    : [];
  if (
    !results.ok ||
    !progression.ok ||
    expectedIds.length !== receivedIds.length ||
    expectedIds.some((eventId, index) => eventId !== receivedIds[index])
  ) {
    throw new GameStatsClientError(
      "sync",
      "invalid_response",
      "The statistics service returned an invalid sync response.",
    );
  }
  return {
    ...result,
    profile: result.profile as PlayerStats,
    progression: progression.value,
    results: results.value,
  };
}

async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  const response = await fetchGameStats("leaderboard", { method: "GET" });

  const body = await readResponseBody(response);
  if (!response.ok) {
    const apiError = (body ?? {}) as Partial<ErrorResponse>;
    throw new GameStatsClientError(
      "leaderboard",
      typeof apiError.code === "string" ? apiError.code : "request_failed",
      typeof apiError.error === "string" ? apiError.error : "Request failed.",
    );
  }

  const result = body as Partial<LeaderboardResponse> | null;
  if (!result || !Array.isArray(result.leaderboard)) {
    throw new GameStatsClientError(
      "leaderboard",
      "invalid_response",
      "The leaderboard service returned an invalid response.",
    );
  }
  return result.leaderboard.filter(isLeaderboardEntry);
}

export function useGameStats({
  language,
}: UseGameStatsOptions): UseGameStatsResult {
  const storeRef = useRef<StoredGameStatsV2>(emptyStoredGameStats());
  const leaderboardRef = useRef<LeaderboardEntry[]>([]);
  const mountedRef = useRef(false);
  const languageRef = useRef(language);
  const syncPromiseRef = useRef<Promise<void> | null>(null);
  const syncAgainRef = useRef(false);
  const [snapshot, setSnapshot] = useState<HookSnapshot>({
    leaderboard: [],
    pendingCount: 0,
    profile: null,
    profileOwnerId: null,
    progression: null,
  });
  const [status, setStatus] = useState<GameStatsSyncStatus>("loading");
  const [error, setError] = useState<GameStatsError | null>(null);

  const publishStore = useCallback(
    (
      update: (current: StoredGameStatsV2) => StoredGameStatsV2,
      persist = true,
    ) => {
      const next = update(storeRef.current);
      if (persist) {
        try {
          writeStoredGameStats(next);
        } catch (storageError) {
          const clientError = new GameStatsClientError(
            "storage",
            "storage_unavailable",
            storageError instanceof Error
              ? storageError.message
              : "Local storage is unavailable.",
          );
          if (mountedRef.current) {
            setStatus("error");
            setError({
              code: clientError.code,
              message: clientError.message,
              operation: "storage",
            });
          }
          throw clientError;
        }
      }
      storeRef.current = next;
      if (mountedRef.current) {
        setSnapshot(toHookSnapshot(next, leaderboardRef.current));
      }
      return next;
    },
    [],
  );

  const publishLeaderboard = useCallback((leaderboard: LeaderboardEntry[]) => {
    leaderboardRef.current = leaderboard;
    if (mountedRef.current) {
      setSnapshot(toHookSnapshot(storeRef.current, leaderboard));
    }
  }, []);

  const runSyncPass = useCallback(async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      if (mountedRef.current) setStatus("offline");
      return;
    }

    if (mountedRef.current) {
      setStatus("syncing");
      setError(null);
    }

    try {
      let storedProfile = storeRef.current.profile;
      if (storedProfile) {
        const accessCode = storedProfile.accessCode;
        const wasRemoteConfirmed = storedProfile.remoteConfirmed;
        const submittedNickname = storedProfile.stats.nickname;
        const hasPendingChanges =
          storedProfile.pendingNickname !== null ||
          storeRef.current.pendingEvents.length > 0;
        const shouldCreate = !wasRemoteConfirmed;
        const shouldRefresh = wasRemoteConfirmed && !hasPendingChanges;

        if (shouldCreate || shouldRefresh) {
          const response = shouldRefresh
            ? await postProfile({ action: "connect", accessCode })
            : await postProfile({
                action: "create",
                accessCode,
                nickname: submittedNickname,
                language: languageRef.current,
              });

          publishStore((current) => {
            if (!current.profile || current.profile.accessCode !== accessCode) {
              return current;
            }
            const latestNickname = current.profile.stats.nickname;
            const needsRename = wasRemoteConfirmed
              ? current.profile.pendingNickname
              : latestNickname !== submittedNickname
                ? latestNickname
                : null;
            const remoteStats = {
              ...response.profile,
              nickname: needsRename ?? response.profile.nickname,
            };
            const optimisticStats = addEventsToStats(
              remoteStats,
              current.pendingEvents,
            );
            return {
              ...current,
              profile: {
                accessCode: normalizeAccessCode(
                  response.accessCode ?? current.profile.accessCode,
                ),
                pendingNickname: needsRename,
                remoteConfirmed: true,
                stats: optimisticStats,
                progression: response.progression
                  ? addEventsToProgression(
                      response.progression,
                      current.pendingEvents,
                      optimisticStats,
                    )
                  : current.profile.progression,
              },
            };
          });
          if (storeRef.current.profile?.accessCode !== accessCode) {
            syncAgainRef.current = true;
            return;
          }
          storedProfile = storeRef.current.profile;
        }
      }

      if (storedProfile?.pendingNickname) {
        const accessCode = storedProfile.accessCode;
        const nickname = storedProfile.pendingNickname;
        const response = await postProfile({
          action: "rename",
          accessCode,
          nickname,
        });
        publishStore((current) => {
          if (!current.profile || current.profile.accessCode !== accessCode) {
            return current;
          }
          const hasNewerRename = current.profile.pendingNickname !== nickname;
          const latestNickname = hasNewerRename
            ? current.profile.stats.nickname
            : response.profile.nickname;
          return {
            ...current,
            profile: {
              ...current.profile,
              pendingNickname: hasNewerRename
                ? current.profile.pendingNickname
                : null,
              stats: addEventsToStats(
                { ...response.profile, nickname: latestNickname },
                current.pendingEvents,
              ),
              progression:
                response.progression ?? current.profile.progression,
            },
          };
        });
        if (storeRef.current.profile?.accessCode !== accessCode) {
          syncAgainRef.current = true;
          return;
        }
      }

      while (storeRef.current.profile && storeRef.current.pendingEvents[0]) {
        const storedEvents = storeRef.current.pendingEvents.slice(
          0,
          MAX_GAME_SYNC_EVENTS,
        );
        const accessCode = storeRef.current.profile.accessCode;
        const response = await postSync(accessCode, storedEvents);
        publishStore((current) => {
          if (!current.profile || current.profile.accessCode !== accessCode) {
            return current;
          }
          const completedIds = new Set(
            response.results.map((result) => result.eventId),
          );
          const pendingEvents = current.pendingEvents.filter(
            (event) => !completedIds.has(event.eventId),
          );
          const nickname =
            current.profile.pendingNickname ?? response.profile.nickname;
          const optimisticStats = addEventsToStats(
            { ...response.profile, nickname },
            pendingEvents,
          );
          return {
            ...current,
            pendingEvents,
            profile: {
              ...current.profile,
              stats: optimisticStats,
              progression: response.progression
                ? addEventsToProgression(
                    response.progression,
                    pendingEvents,
                    optimisticStats,
                  )
                : current.profile.progression,
            },
          };
        });
        if (storeRef.current.profile?.accessCode !== accessCode) {
          syncAgainRef.current = true;
          return;
        }
      }

      publishLeaderboard(await getLeaderboard());
      if (mountedRef.current) {
        setStatus(
          storeRef.current.profile?.remoteConfirmed === false
            ? "local-only"
            : "synced",
        );
        setError(null);
      }
    } catch (syncError) {
      if (!mountedRef.current) return;
      const nextError = asGameStatsError(syncError, "connect");
      setError(nextError);
      setStatus(isOfflineError(syncError) ? "offline" : "error");
    }
  }, [publishLeaderboard, publishStore]);

  const retrySync = useCallback(async () => {
    if (syncPromiseRef.current) {
      syncAgainRef.current = true;
      return syncPromiseRef.current;
    }

    const promise = (async () => {
      do {
        syncAgainRef.current = false;
        await runSyncPass();
      } while (syncAgainRef.current);
    })();
    syncPromiseRef.current = promise;
    try {
      await promise;
    } finally {
      if (syncPromiseRef.current === promise) syncPromiseRef.current = null;
    }
  }, [runSyncPass]);

  const requestSync = useCallback(() => {
    if (typeof window === "undefined") return;
    window.queueMicrotask(() => void retrySync());
  }, [retrySync]);

  const createProfile = useCallback(
    async (requestedNickname?: string) => {
      if (storeRef.current.profile) {
        throw new GameStatsClientError(
          "create",
          "profile_active",
          "Forget the current profile before creating another one.",
        );
      }

      const nickname =
        requestedNickname === undefined
          ? generateRandomNickname(languageRef.current)
          : requestedNickname;
      const validatedNickname = validateNickname(nickname);
      if (!validatedNickname.ok) {
        throw new GameStatsClientError(
          "create",
          "invalid_nickname",
          validatedNickname.error,
        );
      }
      const accessCode = normalizeAccessCode(generateAccessCode());
      const stats = emptyPlayerStats(validatedNickname.value);
      publishStore(() => ({
        knownEventIds: [],
        pendingEvents: [],
        profile: {
          accessCode,
          pendingNickname: null,
          remoteConfirmed: false,
          stats,
          progression: null,
        },
        version: STORAGE_VERSION,
      }));
      if (mountedRef.current) {
        setStatus("local-only");
        setError(null);
      }
      requestSync();
      return { ...stats, accessCode };
    },
    [publishStore, requestSync],
  );

  const connectProfile = useCallback(
    async (requestedAccessCode: string) => {
      const validatedAccessCode = validateAccessCode(requestedAccessCode);
      if (!validatedAccessCode.ok) {
        throw new GameStatsClientError(
          "connect",
          "invalid_access_code",
          validatedAccessCode.error,
        );
      }
      if (storeRef.current.profile) {
        throw new GameStatsClientError(
          "connect",
          "profile_active",
          "Forget the current profile before connecting another one.",
        );
      }

      if (mountedRef.current) {
        setStatus("syncing");
        setError(null);
      }
      try {
        const response = await postProfile({
          action: "connect",
          accessCode: validatedAccessCode.value,
        });
        const accessCode = normalizeAccessCode(
          response.accessCode ?? validatedAccessCode.value,
        );
        publishStore(() => ({
          knownEventIds: [],
          pendingEvents: [],
          profile: {
            accessCode,
            pendingNickname: null,
            remoteConfirmed: true,
            stats: response.profile,
            progression: isPlayerProgression(response.progression)
              ? response.progression
              : null,
          },
          version: STORAGE_VERSION,
        }));
        if (mountedRef.current) {
          setStatus("synced");
          setError(null);
        }
        requestSync();
        return { ...response.profile, accessCode };
      } catch (connectError) {
        const nextError = asGameStatsError(connectError, "connect");
        if (mountedRef.current) {
          setError(nextError);
          setStatus(isOfflineError(connectError) ? "offline" : "error");
        }
        throw connectError;
      }
    },
    [publishStore, requestSync],
  );

  const renameProfile = useCallback(
    async (requestedNickname: string) => {
      const validatedNickname = validateNickname(requestedNickname);
      if (!validatedNickname.ok) {
        throw new GameStatsClientError(
          "rename",
          "invalid_nickname",
          validatedNickname.error,
        );
      }
      if (!storeRef.current.profile) {
        throw new GameStatsClientError(
          "rename",
          "profile_missing",
          "Create or connect a profile first.",
        );
      }
      publishStore((current) => {
        if (!current.profile) return current;
        return {
          ...current,
          profile: {
            ...current.profile,
            pendingNickname: current.profile.remoteConfirmed
              ? validatedNickname.value
              : null,
            stats: {
              ...current.profile.stats,
              nickname: validatedNickname.value,
              updatedAt: new Date().toISOString(),
            },
          },
        };
      });
      if (mountedRef.current) {
        setStatus(
          storeRef.current.profile?.remoteConfirmed
            ? "syncing"
            : "local-only",
        );
        setError(null);
      }
      requestSync();
    },
    [publishStore, requestSync],
  );

  const forgetProfile = useCallback(() => {
    try {
      publishStore(() => emptyStoredGameStats());
    } catch {
      return;
    }
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch {
        // The v2 tombstone is already durable; a stale v1 value is ignored.
      }
    }
    if (mountedRef.current) {
      setStatus(
        typeof navigator !== "undefined" && !navigator.onLine
          ? "offline"
          : "synced",
      );
      setError(null);
    }
  }, [publishStore]);

  const recordRun = useCallback(
    (
      run: GameRunInput,
      expectedProfileOwnerId?: string | null,
    ): GameRunRecordResult => {
      const validatedRun = validateRunSummary(run);
      const storedProfile = storeRef.current.profile;
      if (!validatedRun.ok || !storedProfile) return "invalid";
      if (
        expectedProfileOwnerId &&
        profileOwnerIdFromAccessCode(storedProfile.accessCode) !==
          expectedProfileOwnerId
      ) {
        return "profile-mismatch";
      }
      if (
        storeRef.current.knownEventIds.includes(validatedRun.value.runId) ||
        storeRef.current.pendingEvents.some(
          (pendingEvent) => pendingEvent.eventId === validatedRun.value.runId,
        )
      ) {
        return "duplicate";
      }

      const event: RunCompletedSyncEvent = {
        eventId: validatedRun.value.runId,
        kind: "run.completed",
        version: 2,
        payload: validatedRun.value,
      };

      try {
        publishStore((current) => {
          if (
            !current.profile ||
            current.profile.accessCode !== storedProfile.accessCode
          ) {
            return current;
          }
          const nextStats = addRunToStats(
            current.profile.stats,
            validatedRun.value,
          );
          const baseProgression =
            current.profile.progression ??
            addEventsToProgression(
              null,
              current.pendingEvents,
              current.profile.stats,
            );
          return {
            ...current,
            knownEventIds: [
              ...current.knownEventIds,
              validatedRun.value.runId,
            ].slice(-MAX_REMEMBERED_RUN_IDS),
            pendingEvents: [...current.pendingEvents, event],
            profile: {
              ...current.profile,
              stats: nextStats,
              progression: addRunToProgression(
                baseProgression,
                validatedRun.value,
                nextStats,
              ),
            },
          };
        });
      } catch {
        return "storage-error";
      }
      if (mountedRef.current) {
        setStatus(
          typeof navigator !== "undefined" && !navigator.onLine
            ? "offline"
            : "syncing",
        );
        setError(null);
      }
      requestSync();
      return "queued";
    },
    [publishStore, requestSync],
  );

  useEffect(() => {
    languageRef.current = language;
  }, [language]);

  useEffect(() => {
    mountedRef.current = true;
    const stored = readStoredGameStats();
    storeRef.current = stored;
    setSnapshot(toHookSnapshot(stored, leaderboardRef.current));
    setStatus(
      typeof navigator !== "undefined" && !navigator.onLine
        ? "offline"
        : stored.profile?.remoteConfirmed === false
          ? "local-only"
          : "loading",
    );

    const handleOnline = () => void retrySync();
    const handleOffline = () => setStatus("offline");
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      try {
        const next = event.newValue
          ? sanitizeStoredGameStatsV2(JSON.parse(event.newValue) as unknown)
          : emptyStoredGameStats();
        const shouldPersistMergedQueue = shouldPersistMergedGameStats(
          storeRef.current,
          next,
        );
        publishStore(
          (current) => mergeStoredGameStatsV2(current, next),
          shouldPersistMergedQueue,
        );
        requestSync();
      } catch {
        // Ignore malformed values written by another tab or an older build.
      }
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("storage", handleStorage);
    void retrySync();

    return () => {
      mountedRef.current = false;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("storage", handleStorage);
    };
  }, [publishStore, requestSync, retrySync]);

  return {
    ...snapshot,
    status,
    error,
    createProfile,
    connectProfile,
    renameProfile,
    forgetProfile,
    retrySync,
    recordRun,
  };
}
