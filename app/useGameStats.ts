"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GAME_STATS_API_PATH,
  type ErrorResponse,
  type GameStatsLanguage,
  type GameStatsRequest,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type PlayerStats,
  type ProfileResponse,
  type ValidatedRun,
  generateAccessCode,
  generateRandomNickname,
  normalizeAccessCode,
  validateAccessCode,
  validateNickname,
  validateRun,
} from "../shared/gameStats";

const STORAGE_KEY = "arduino-gate-game-stats:v1";
const STORAGE_VERSION = 1;
const MAX_REMEMBERED_RUN_IDS = 100;

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

export type GameRunInput = ValidatedRun;

type StoredProfile = {
  accessCode: string;
  pendingNickname: string | null;
  remoteConfirmed: boolean;
  stats: PlayerStats;
};

type StoredGameStats = {
  knownRunIds: string[];
  pendingRuns: ValidatedRun[];
  profile: StoredProfile | null;
  version: typeof STORAGE_VERSION;
};

type HookSnapshot = {
  leaderboard: LeaderboardEntry[];
  pendingCount: number;
  profile: GameStatsProfile | null;
};

export type UseGameStatsResult = HookSnapshot & {
  status: GameStatsSyncStatus;
  error: GameStatsError | null;
  createProfile: (nickname?: string) => Promise<GameStatsProfile>;
  connectProfile: (accessCode: string) => Promise<GameStatsProfile>;
  renameProfile: (nickname: string) => Promise<void>;
  forgetProfile: () => void;
  retrySync: () => Promise<void>;
  recordRun: (run: GameRunInput) => boolean;
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

function emptyStoredGameStats(): StoredGameStats {
  return {
    knownRunIds: [],
    pendingRuns: [],
    profile: null,
    version: STORAGE_VERSION,
  };
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
    isNonNegativeSafeInteger(stats.highestLevel) &&
    isNonNegativeSafeInteger(stats.totalDurationMs) &&
    typeof stats.updatedAt === "string"
  );
}

function isLeaderboardEntry(value: unknown): value is LeaderboardEntry {
  return (
    isPlayerStats(value) &&
    isNonNegativeSafeInteger((value as Partial<LeaderboardEntry>).rank) &&
    (value as LeaderboardEntry).rank > 0
  );
}

function sanitizeStoredGameStats(value: unknown): StoredGameStats {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyStoredGameStats();
  }

  const candidate = value as Partial<StoredGameStats>;
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
      profile = {
        accessCode: accessCode.value,
        pendingNickname:
          pendingNickname === null ? null : pendingNickname.value,
        remoteConfirmed: rawProfile.remoteConfirmed,
        stats: rawProfile.stats,
      };
    }
  }

  const pendingRuns = Array.isArray(candidate.pendingRuns)
    ? candidate.pendingRuns.flatMap((run) => {
        const result = validateRun(run);
        return result.ok ? [result.value] : [];
      })
    : [];
  const uniquePendingRuns = pendingRuns.filter(
    (run, index, runs) =>
      runs.findIndex((candidateRun) => candidateRun.runId === run.runId) ===
      index,
  );
  const knownRunIds = Array.isArray(candidate.knownRunIds)
    ? candidate.knownRunIds.filter(
        (runId): runId is string =>
          typeof runId === "string" &&
          validateRun({ runId, score: 0, level: 1, durationMs: 0 }).ok,
      )
    : [];

  return {
    knownRunIds: Array.from(
      new Set([...knownRunIds, ...uniquePendingRuns.map((run) => run.runId)]),
    ).slice(-MAX_REMEMBERED_RUN_IDS),
    pendingRuns: profile ? uniquePendingRuns : [],
    profile,
    version: STORAGE_VERSION,
  };
}

function readStoredGameStats() {
  if (typeof window === "undefined") return emptyStoredGameStats();
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored
      ? sanitizeStoredGameStats(JSON.parse(stored) as unknown)
      : emptyStoredGameStats();
  } catch {
    return emptyStoredGameStats();
  }
}

function writeStoredGameStats(store: StoredGameStats) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function toHookSnapshot(
  store: StoredGameStats,
  leaderboard: LeaderboardEntry[],
): HookSnapshot {
  const profile = store.profile
    ? { ...store.profile.stats, accessCode: store.profile.accessCode }
    : null;
  return {
    leaderboard,
    pendingCount: store.pendingRuns.length,
    profile,
  };
}

function addRunToStats(stats: PlayerStats, run: ValidatedRun): PlayerStats {
  return {
    ...stats,
    gamesPlayed: stats.gamesPlayed + 1,
    totalScore: stats.totalScore + run.score,
    highScore: Math.max(stats.highScore, run.score),
    highestLevel: Math.max(stats.highestLevel, run.level),
    totalDurationMs: stats.totalDurationMs + run.durationMs,
    updatedAt: new Date().toISOString(),
  };
}

function addRunsToStats(stats: PlayerStats, runs: ValidatedRun[]) {
  return runs.reduce(addRunToStats, stats);
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

async function postProfile(request: GameStatsRequest): Promise<ProfileResponse> {
  let response: Response;
  try {
    response = await fetch(GAME_STATS_API_PATH, {
      body: JSON.stringify(request),
      cache: "no-store",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch (error) {
    throw new GameStatsClientError(
      request.action,
      "network_error",
      error instanceof Error ? error.message : "Network request failed.",
    );
  }

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
  return result as ProfileResponse;
}

async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  let response: Response;
  try {
    response = await fetch(GAME_STATS_API_PATH, {
      cache: "no-store",
      credentials: "omit",
      method: "GET",
    });
  } catch (error) {
    throw new GameStatsClientError(
      "leaderboard",
      "network_error",
      error instanceof Error ? error.message : "Network request failed.",
    );
  }

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
  const storeRef = useRef<StoredGameStats>(emptyStoredGameStats());
  const leaderboardRef = useRef<LeaderboardEntry[]>([]);
  const mountedRef = useRef(false);
  const languageRef = useRef(language);
  const syncPromiseRef = useRef<Promise<void> | null>(null);
  const syncAgainRef = useRef(false);
  const [snapshot, setSnapshot] = useState<HookSnapshot>({
    leaderboard: [],
    pendingCount: 0,
    profile: null,
  });
  const [status, setStatus] = useState<GameStatsSyncStatus>("loading");
  const [error, setError] = useState<GameStatsError | null>(null);

  const publishStore = useCallback(
    (
      update: (current: StoredGameStats) => StoredGameStats,
      persist = true,
    ) => {
      const next = update(storeRef.current);
      storeRef.current = next;
      if (persist) {
        try {
          writeStoredGameStats(next);
        } catch (storageError) {
          if (mountedRef.current) {
            setStatus("error");
            setError({
              code: "storage_unavailable",
              message:
                storageError instanceof Error
                  ? storageError.message
                  : "Local storage is unavailable.",
              operation: "storage",
            });
          }
        }
      }
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
          storeRef.current.pendingRuns.length > 0;
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
            return {
              ...current,
              profile: {
                accessCode: normalizeAccessCode(
                  response.accessCode ?? current.profile.accessCode,
                ),
                pendingNickname: needsRename,
                remoteConfirmed: true,
                stats: addRunsToStats(remoteStats, current.pendingRuns),
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
              stats: addRunsToStats(
                { ...response.profile, nickname: latestNickname },
                current.pendingRuns,
              ),
            },
          };
        });
        if (storeRef.current.profile?.accessCode !== accessCode) {
          syncAgainRef.current = true;
          return;
        }
      }

      while (storeRef.current.profile && storeRef.current.pendingRuns[0]) {
        const storedRun = storeRef.current.pendingRuns[0];
        const accessCode = storeRef.current.profile.accessCode;
        const response = await postProfile({
          action: "record",
          accessCode,
          ...storedRun,
        });
        publishStore((current) => {
          if (!current.profile || current.profile.accessCode !== accessCode) {
            return current;
          }
          const pendingRuns = current.pendingRuns.filter(
            (run) => run.runId !== storedRun.runId,
          );
          const nickname =
            current.profile.pendingNickname ?? response.profile.nickname;
          return {
            ...current,
            pendingRuns,
            profile: {
              ...current.profile,
              stats: addRunsToStats(
                { ...response.profile, nickname },
                pendingRuns,
              ),
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
        knownRunIds: [],
        pendingRuns: [],
        profile: {
          accessCode,
          pendingNickname: null,
          remoteConfirmed: false,
          stats,
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
          knownRunIds: [],
          pendingRuns: [],
          profile: {
            accessCode,
            pendingNickname: null,
            remoteConfirmed: true,
            stats: response.profile,
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
    publishStore(() => emptyStoredGameStats());
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
    (run: GameRunInput) => {
      const validatedRun = validateRun(run);
      if (!validatedRun.ok || !storeRef.current.profile) return false;
      if (
        storeRef.current.knownRunIds.includes(validatedRun.value.runId) ||
        storeRef.current.pendingRuns.some(
          (pendingRun) => pendingRun.runId === validatedRun.value.runId,
        )
      ) {
        return false;
      }

      publishStore((current) => {
        if (!current.profile) return current;
        return {
          ...current,
          knownRunIds: [...current.knownRunIds, validatedRun.value.runId].slice(
            -MAX_REMEMBERED_RUN_IDS,
          ),
          pendingRuns: [...current.pendingRuns, validatedRun.value],
          profile: {
            ...current.profile,
            stats: addRunToStats(current.profile.stats, validatedRun.value),
          },
        };
      });
      if (mountedRef.current) {
        setStatus(
          typeof navigator !== "undefined" && !navigator.onLine
            ? "offline"
            : "syncing",
        );
        setError(null);
      }
      requestSync();
      return true;
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
          ? sanitizeStoredGameStats(JSON.parse(event.newValue) as unknown)
          : emptyStoredGameStats();
        publishStore(() => next, false);
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
  }, [publishStore, retrySync]);

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
