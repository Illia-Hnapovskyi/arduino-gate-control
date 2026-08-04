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

const STORAGE_KEY_V1 = "arduino-gate-game-stats:v1";
const STORAGE_KEY_V2 = "arduino-gate-game-stats:v2";
export const STORAGE_KEY_V3 = "arduino-gate-game-stats:v3";
const STORAGE_VERSION_V2 = 2;
const STORAGE_VERSION_V3 = 3;
const MAX_REMEMBERED_RUN_IDS = 100;
const REQUEST_TIMEOUT_MS = 12_000;

const LOCAL_PROFILE_ID_PATTERN = /^profile_[0-9a-f]{16}$/;
const PROFILE_PUBLIC_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  | "storage"
  | "link"
  | "unlink"
  | "session";

export type GameStatsError = {
  code: string;
  message: string;
  operation: GameStatsOperation;
};

export type GameStatsProfile = PlayerStats & {
  accessCode: string | null;
  accountLinked: boolean;
  publicId: string | null;
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
  version: typeof STORAGE_VERSION_V2;
};

export type StoredProfileV3 = {
  profileId: string;
  checkpointOwnerId: string;
  accessCode: string | null;
  publicId: string | null;
  // The verified account that owns this profile; null for code-only profiles
  // and for account profiles stored before this field existed.
  authUserId: string | null;
  accountLinked: boolean;
  pendingNickname: string | null;
  remoteConfirmed: boolean;
  stats: PlayerStats;
  progression: PlayerProgression | null;
  pendingEvents: RunCompletedSyncEvent[];
  knownEventIds: string[];
};

export type StoredGameStatsV3 = {
  version: typeof STORAGE_VERSION_V3;
  activeProfileId: string | null;
  profiles: StoredProfileV3[];
};

export type GameStatsProfileSummary = {
  profileId: string;
  nickname: string;
  accountLinked: boolean;
  hasAccessCode: boolean;
  publicId: string | null;
};

export type AdoptableProfileResponse = ProfileResponse & {
  profilePublicId?: string;
  accountLinked?: boolean;
};

export type LinkProfileResult =
  | "linked"
  | "already-linked"
  | "account-conflict"
  | "profile-conflict";

export type AdoptProfileResult = "adopted" | "conflict";

export type ConflictResolution = "keep-local" | "use-account";

export type GameStatsAccountConflict = {
  accountProfile: GameStatsProfileSummary;
};

type HookSnapshot = {
  activeProfileId: string | null;
  leaderboard: LeaderboardEntry[];
  pendingCount: number;
  profile: GameStatsProfile | null;
  profileOwnerId: string | null;
  profiles: GameStatsProfileSummary[];
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
  forgetProfile: (options?: { force?: boolean }) => void;
  retrySync: () => Promise<void>;
  recordRun: (
    run: GameRunInput,
    expectedProfileOwnerId?: string | null,
  ) => GameRunRecordResult;
  switchProfile: (profileId: string) => boolean;
  adoptSessionProfile: (
    response: AdoptableProfileResponse,
    authUserId?: string | null,
  ) => AdoptProfileResult;
  linkActiveProfile: () => Promise<LinkProfileResult>;
  unlinkActiveProfile: () => Promise<void>;
  accountConflict: GameStatsAccountConflict | null;
  resolveConflict: (choice: ConflictResolution) => void;
};

export type UseGameStatsOptions = {
  language: GameStatsLanguage;
  getAccessToken?: () => Promise<string | null>;
  isRunActive?: () => boolean;
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

// The backend request bodies for the account actions are declared inline so this
// file compiles before the shared LinkStatsRequest/UnlinkStatsRequest/
// SessionStatsRequest types land; action names and fields match the server
// credential matrix exactly.
type LinkRequestBody = { action: "link"; accessCode: string };
type UnlinkRequestBody = { action: "unlink"; accessCode: string };
type SessionRequestBody = { action: "session" };
type BearerRenameRequestBody = { action: "rename"; nickname: string };
type BearerSyncRequestBody = { action: "sync"; events: GameSyncEvent[] };
type HookStatsRequest =
  | GameStatsRequest
  | LinkRequestBody
  | UnlinkRequestBody
  | SessionRequestBody
  | BearerRenameRequestBody
  | BearerSyncRequestBody;

function emptyStoredGameStats(): StoredGameStatsV2 {
  return {
    knownEventIds: [],
    pendingEvents: [],
    profile: null,
    version: STORAGE_VERSION_V2,
  };
}

export function emptyStoredGameStatsV3(): StoredGameStatsV3 {
  return {
    version: STORAGE_VERSION_V3,
    activeProfileId: null,
    profiles: [],
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

export function mintLocalProfileId(): string {
  const secureCrypto = (globalThis as { crypto?: Crypto }).crypto;
  const bytes = new Uint8Array(8);
  if (secureCrypto?.getRandomValues) {
    secureCrypto.getRandomValues(bytes);
  } else {
    // Non-secure fallback for exotic runtimes; only local uniqueness matters.
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return `profile_${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function normalizeProfilePublicId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return PROFILE_PUBLIC_ID_PATTERN.test(normalized) ? normalized : null;
}

function normalizeAuthUserId(value: unknown): string | null {
  // Supabase user ids are UUIDs, exactly the shape of the profile public id.
  return normalizeProfilePublicId(value);
}

function decodeBase64UrlToText(segment: string): string | null {
  if (typeof atob !== "function") return null;
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Reads the `sub` claim without verifying the signature. This is only used as a
 * local ownership guard so one account's session can never drain another
 * account's queue; the server remains the sole authority on the token.
 */
export function readAccessTokenSubject(accessToken: string): string | null {
  const segments = accessToken.split(".");
  if (segments.length !== 3) return null;
  const payload = decodeBase64UrlToText(segments[1]);
  if (payload === null) return null;
  try {
    const claims = JSON.parse(payload) as { sub?: unknown };
    return normalizeAuthUserId(claims.sub);
  } catch {
    return null;
  }
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

function sanitizePendingEvents(value: unknown): RunCompletedSyncEvent[] {
  const pendingEvents = Array.isArray(value)
    ? value.flatMap((event) => {
        const result = validateGameSyncEvent(event);
        return result.ok && result.value.kind === "run.completed"
          ? [result.value]
          : [];
      })
    : [];
  return pendingEvents.filter(
    (event, index, events) =>
      events.findIndex(
        (candidateEvent) => candidateEvent.eventId === event.eventId,
      ) === index,
  );
}

function sanitizeKnownEventIds(
  value: unknown,
  pendingEvents: RunCompletedSyncEvent[],
): string[] {
  const knownEventIds = Array.isArray(value)
    ? value.filter(
        (eventId): eventId is string =>
          typeof eventId === "string" &&
          validateRun({ runId: eventId, score: 0, level: 1, durationMs: 0 }).ok,
      )
    : [];
  return Array.from(
    new Set([...knownEventIds, ...pendingEvents.map((event) => event.eventId)]),
  ).slice(-MAX_REMEMBERED_RUN_IDS);
}

export function sanitizeStoredGameStatsV2(value: unknown): StoredGameStatsV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyStoredGameStats();
  }

  const candidate = value as Partial<StoredGameStatsV2>;
  if (candidate.version !== STORAGE_VERSION_V2) return emptyStoredGameStats();

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

  const uniquePendingEvents = sanitizePendingEvents(candidate.pendingEvents);
  return {
    knownEventIds: sanitizeKnownEventIds(
      candidate.knownEventIds,
      uniquePendingEvents,
    ),
    pendingEvents: profile ? uniquePendingEvents : [],
    profile,
    version: STORAGE_VERSION_V2,
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
    version: STORAGE_VERSION_V2,
  };
}

export function migrateStoredGameStatsV2ToV3(
  value: StoredGameStatsV2,
): StoredGameStatsV3 {
  if (!value.profile) return emptyStoredGameStatsV3();
  // The local id is derived from the access code exactly like the checkpoint
  // owner id always was, so existing checkpoints keep resolving and a rollback
  // to the previous build re-derives the identical value.
  const profileId = profileOwnerIdFromAccessCode(value.profile.accessCode);
  return {
    version: STORAGE_VERSION_V3,
    activeProfileId: profileId,
    profiles: [
      {
        profileId,
        checkpointOwnerId: profileId,
        accessCode: value.profile.accessCode,
        publicId: null,
        authUserId: null,
        accountLinked: false,
        pendingNickname: value.profile.pendingNickname,
        remoteConfirmed: value.profile.remoteConfirmed,
        stats: value.profile.stats,
        progression: value.profile.progression,
        pendingEvents: value.pendingEvents,
        knownEventIds: value.knownEventIds,
      },
    ],
  };
}

function sanitizeStoredProfileV3(value: unknown): StoredProfileV3 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<StoredProfileV3>;

  let accessCode: string | null = null;
  if (raw.accessCode !== null) {
    const validated = validateAccessCode(raw.accessCode);
    if (!validated.ok) return null;
    accessCode = validated.value;
  }

  const derivedId = accessCode !== null
    ? profileOwnerIdFromAccessCode(accessCode)
    : null;
  // checkpointOwnerId is immutable once minted; it is only re-derived (code
  // profiles) or re-minted (account profiles) when the stored value is corrupt,
  // because dropping the profile entirely would lose data.
  const checkpointOwnerId =
    typeof raw.checkpointOwnerId === "string" &&
    LOCAL_PROFILE_ID_PATTERN.test(raw.checkpointOwnerId)
      ? raw.checkpointOwnerId
      : (derivedId ?? mintLocalProfileId());
  const profileId =
    typeof raw.profileId === "string" &&
    LOCAL_PROFILE_ID_PATTERN.test(raw.profileId)
      ? raw.profileId
      : (derivedId ?? checkpointOwnerId);

  const pendingNickname =
    raw.pendingNickname === null ? null : validateNickname(raw.pendingNickname);
  if (
    !isPlayerStats(raw.stats) ||
    typeof raw.remoteConfirmed !== "boolean" ||
    !(pendingNickname === null || pendingNickname.ok)
  ) {
    return null;
  }
  const progression = validatePlayerProgression(raw.progression);
  const pendingEvents = sanitizePendingEvents(raw.pendingEvents);
  return {
    profileId,
    checkpointOwnerId,
    accessCode,
    publicId: normalizeProfilePublicId(raw.publicId),
    authUserId: normalizeAuthUserId(raw.authUserId),
    accountLinked:
      typeof raw.accountLinked === "boolean"
        ? raw.accountLinked
        : accessCode === null,
    pendingNickname: pendingNickname === null ? null : pendingNickname.value,
    remoteConfirmed: raw.remoteConfirmed,
    stats: raw.stats,
    progression: progression.ok ? progression.value : null,
    pendingEvents,
    knownEventIds: sanitizeKnownEventIds(raw.knownEventIds, pendingEvents),
  };
}

export function sanitizeStoredGameStatsV3(value: unknown): StoredGameStatsV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyStoredGameStatsV3();
  }
  const candidate = value as Partial<StoredGameStatsV3>;
  if (candidate.version !== STORAGE_VERSION_V3) return emptyStoredGameStatsV3();

  const profiles: StoredProfileV3[] = [];
  if (Array.isArray(candidate.profiles)) {
    for (const rawProfile of candidate.profiles) {
      const profile = sanitizeStoredProfileV3(rawProfile);
      if (
        profile &&
        !profiles.some((existing) => existing.profileId === profile.profileId)
      ) {
        profiles.push(profile);
      }
    }
  }
  const activeProfileId =
    typeof candidate.activeProfileId === "string" &&
    profiles.some((profile) => profile.profileId === candidate.activeProfileId)
      ? candidate.activeProfileId
      : null;
  return {
    version: STORAGE_VERSION_V3,
    activeProfileId,
    profiles,
  };
}

type ReadStoredGameStatsResult = {
  store: StoredGameStatsV3;
  migrated: boolean;
};

function readStoredGameStats(): ReadStoredGameStatsResult {
  if (typeof window === "undefined") {
    return { store: emptyStoredGameStatsV3(), migrated: false };
  }
  let storedV3: string | null = null;
  let storedV2: string | null = null;
  let legacy: string | null = null;
  try {
    storedV3 = window.localStorage.getItem(STORAGE_KEY_V3);
    storedV2 = window.localStorage.getItem(STORAGE_KEY_V2);
    legacy = window.localStorage.getItem(STORAGE_KEY_V1);
  } catch {
    return { store: emptyStoredGameStatsV3(), migrated: false };
  }

  if (storedV3) {
    try {
      const parsed = JSON.parse(storedV3) as unknown;
      const sanitized = sanitizeStoredGameStatsV3(parsed);
      const rawProfiles =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as { profiles?: unknown }).profiles
          : undefined;
      const explicitlyEmpty =
        Array.isArray(rawProfiles) && rawProfiles.length === 0;
      if (
        sanitized.profiles.length > 0 ||
        explicitlyEmpty ||
        (!storedV2 && !legacy)
      ) {
        return { store: sanitized, migrated: false };
      }
      // A corrupted v3 value must not hide recoverable v2/v1 data.
    } catch {
      // Fall back to the retained v2/v1 values if the v3 write was interrupted.
    }
  } else if (!storedV2 && !legacy) {
    return { store: emptyStoredGameStatsV3(), migrated: false };
  }

  // One-time migration; the v2 and v1 keys are read-only forever from here on.
  let v2Shape: StoredGameStatsV2 | null = null;
  if (storedV2) {
    try {
      const parsed = JSON.parse(storedV2) as unknown;
      const sanitized = sanitizeStoredGameStatsV2(parsed);
      const rawProfile =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as { profile?: unknown }).profile
          : undefined;
      if (sanitized.profile || rawProfile === null || !legacy) {
        v2Shape = sanitized;
      }
      // A version-two object with a malformed non-null profile must not hide a
      // recoverable version-one profile and its pending runs.
    } catch {
      // Fall back to the retained v1 value if the v2 value was interrupted.
    }
  }
  if (!v2Shape && legacy) {
    try {
      v2Shape = migrateStoredGameStatsV1(JSON.parse(legacy) as unknown);
    } catch {
      v2Shape = null;
    }
  }
  return {
    store: migrateStoredGameStatsV2ToV3(v2Shape ?? emptyStoredGameStats()),
    migrated: true,
  };
}

function writeStoredGameStatsV3(store: StoredGameStatsV3) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(store));
}

function activeProfileOf(store: StoredGameStatsV3): StoredProfileV3 | null {
  if (store.activeProfileId === null) return null;
  return (
    store.profiles.find(
      (profile) => profile.profileId === store.activeProfileId,
    ) ?? null
  );
}

function profileSummary(profile: StoredProfileV3): GameStatsProfileSummary {
  return {
    profileId: profile.profileId,
    nickname: profile.stats.nickname,
    accountLinked: profile.accountLinked,
    hasAccessCode: profile.accessCode !== null,
    publicId: profile.publicId,
  };
}

function toHookSnapshot(
  store: StoredGameStatsV3,
  leaderboard: LeaderboardEntry[],
): HookSnapshot {
  const active = activeProfileOf(store);
  const profile = active
    ? {
        ...active.stats,
        accessCode: active.accessCode,
        accountLinked: active.accountLinked,
        publicId: active.publicId,
      }
    : null;
  return {
    activeProfileId: active ? active.profileId : null,
    leaderboard,
    pendingCount: active ? active.pendingEvents.length : 0,
    profile,
    profileOwnerId: active ? active.checkpointOwnerId : null,
    profiles: store.profiles.map(profileSummary),
    progression: active
      ? (active.progression ??
        addEventsToProgression(null, active.pendingEvents, active.stats))
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
    version: STORAGE_VERSION_V2,
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

export function mergeStoredProfilesV3(
  current: StoredProfileV3,
  incoming: StoredProfileV3,
): StoredProfileV3 {
  const currentRevision = current.progression?.serverRevision ?? 0;
  const incomingRevision = incoming.progression?.serverRevision ?? 0;
  const currentUpdatedAt = Date.parse(current.stats.updatedAt) || 0;
  const incomingUpdatedAt = Date.parse(incoming.stats.updatedAt) || 0;
  const tieBreakerComparison =
    Math.sign(incoming.stats.gamesPlayed - current.stats.gamesPlayed) ||
    Math.sign(incoming.stats.totalScore - current.stats.totalScore) ||
    Math.sign(incoming.stats.highScore - current.stats.highScore) ||
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
    ...addEventsToStats(base.stats, missingEvents),
    updatedAt: new Date(
      Math.max(currentUpdatedAt, incomingUpdatedAt),
    ).toISOString(),
  };
  const baseProgression =
    base.progression ??
    addEventsToProgression(null, base.pendingEvents, base.stats);
  const optimisticProgression = addEventsToProgression(
    baseProgression,
    missingEvents,
    optimisticStats,
  );

  return {
    profileId: current.profileId,
    // The checkpoint owner id was minted once and never changes afterwards.
    checkpointOwnerId: current.checkpointOwnerId,
    accessCode: current.accessCode ?? incoming.accessCode,
    publicId: current.publicId ?? incoming.publicId,
    authUserId: current.authUserId ?? incoming.authUserId,
    accountLinked: current.accountLinked || incoming.accountLinked,
    pendingNickname: base.pendingNickname,
    remoteConfirmed: current.remoteConfirmed || incoming.remoteConfirmed,
    stats: optimisticStats,
    progression: optimisticProgression,
    pendingEvents,
    knownEventIds: Array.from(
      new Set([
        ...base.knownEventIds,
        ...other.knownEventIds,
        ...pendingEvents.map((event) => event.eventId),
      ]),
    )
      .sort()
      .slice(-MAX_REMEMBERED_RUN_IDS),
  };
}

export function mergeStoredGameStatsV3(
  current: StoredGameStatsV3,
  incoming: StoredGameStatsV3,
): StoredGameStatsV3 {
  // Union by profileId: an entry the incoming blob lacks is KEPT, never dropped.
  const profiles: StoredProfileV3[] = [];
  for (const profile of current.profiles) {
    const other = incoming.profiles.find(
      (entry) => entry.profileId === profile.profileId,
    );
    profiles.push(other ? mergeStoredProfilesV3(profile, other) : profile);
  }
  for (const profile of incoming.profiles) {
    if (!profiles.some((entry) => entry.profileId === profile.profileId)) {
      profiles.push(profile);
    }
  }
  // Canonical ordering keeps repeated cross-tab merges convergent.
  profiles.sort((left, right) => left.profileId.localeCompare(right.profileId));

  // The same server profile can exist twice locally when one tab learned its
  // publicId late (a queue that never drains keeps the id null). Collapse those
  // entries into one so the queue is unioned instead of forked. The survivor is
  // the lexicographically first profileId, which makes the collapse independent
  // of the merge direction, and its checkpointOwnerId is never rewritten.
  const collapsed: StoredProfileV3[] = [];
  const redirects = new Map<string, string>();
  for (const profile of profiles) {
    const duplicateIndex =
      profile.publicId === null
        ? -1
        : collapsed.findIndex((entry) => entry.publicId === profile.publicId);
    if (duplicateIndex < 0) {
      collapsed.push(profile);
      continue;
    }
    const base = collapsed[duplicateIndex];
    collapsed[duplicateIndex] = mergeStoredProfilesV3(base, profile);
    redirects.set(profile.profileId, base.profileId);
  }

  const resolveActiveProfileId = (profileId: string | null) => {
    if (profileId === null) return null;
    const target = redirects.get(profileId) ?? profileId;
    return collapsed.some((profile) => profile.profileId === target)
      ? target
      : null;
  };
  const activeProfileId =
    resolveActiveProfileId(current.activeProfileId) ??
    resolveActiveProfileId(incoming.activeProfileId);
  return {
    version: STORAGE_VERSION_V3,
    activeProfileId,
    profiles: collapsed,
  };
}

export function upsertProfileInStore(
  store: StoredGameStatsV3,
  profile: StoredProfileV3,
  activate: boolean,
): StoredGameStatsV3 {
  const profiles = [
    ...store.profiles.filter((entry) => entry.profileId !== profile.profileId),
    profile,
  ].sort((left, right) => left.profileId.localeCompare(right.profileId));
  return {
    version: STORAGE_VERSION_V3,
    activeProfileId: activate ? profile.profileId : store.activeProfileId,
    profiles,
  };
}

export function forgetActiveProfileInStore(
  store: StoredGameStatsV3,
): StoredGameStatsV3 {
  if (store.activeProfileId === null) return store;
  return {
    version: STORAGE_VERSION_V3,
    activeProfileId: null,
    profiles: store.profiles.filter(
      (profile) => profile.profileId !== store.activeProfileId,
    ),
  };
}

function updateProfileInStore(
  store: StoredGameStatsV3,
  profileId: string,
  mutate: (profile: StoredProfileV3) => StoredProfileV3,
): StoredGameStatsV3 {
  const index = store.profiles.findIndex(
    (profile) => profile.profileId === profileId,
  );
  if (index < 0) return store;
  const profiles = [...store.profiles];
  profiles[index] = mutate(profiles[index]);
  return { ...store, profiles };
}

export function buildAdoptedProfile(
  store: StoredGameStatsV3,
  response: AdoptableProfileResponse,
  authUserId: string | null = null,
  mintProfileId: () => string = mintLocalProfileId,
): StoredProfileV3 {
  if (!isPlayerStats(response.profile)) {
    throw new GameStatsClientError(
      "session",
      "invalid_response",
      "The statistics service returned an invalid response.",
    );
  }
  let accessCode: string | null = null;
  if (response.accessCode !== undefined) {
    const validated = validateAccessCode(response.accessCode);
    if (!validated.ok) {
      throw new GameStatsClientError(
        "session",
        "invalid_response",
        "The statistics service returned an invalid profile code.",
      );
    }
    accessCode = validated.value;
  }
  let progression: PlayerProgression | null = null;
  if (response.progression !== undefined) {
    const validated = validatePlayerProgression(response.progression);
    if (!validated.ok) {
      throw new GameStatsClientError(
        "session",
        "invalid_response",
        "The statistics service returned invalid progression data.",
      );
    }
    progression = validated.value;
  }
  const publicId = normalizeProfilePublicId(response.profilePublicId);
  const sessionUserId = normalizeAuthUserId(authUserId);
  const derivedId =
    accessCode !== null ? profileOwnerIdFromAccessCode(accessCode) : null;
  // Dedup first by the server public id, then by the code-derived local id, so
  // adopting the same profile twice can never create a duplicate vault entry.
  const existing =
    (publicId
      ? store.profiles.find((profile) => profile.publicId === publicId)
      : undefined) ??
    (derivedId
      ? store.profiles.find((profile) => profile.profileId === derivedId)
      : undefined);
  if (existing) {
    const optimisticStats = addEventsToStats(
      response.profile,
      existing.pendingEvents,
    );
    return {
      ...existing,
      // checkpointOwnerId stays untouched: adoption never re-mints it.
      accessCode: existing.accessCode ?? accessCode,
      publicId: existing.publicId ?? publicId,
      // Adoption follows a freshly verified session, so its user id wins over a
      // stale one; without a session id the stored owner is kept.
      authUserId: sessionUserId ?? existing.authUserId,
      accountLinked: response.accountLinked ?? true,
      remoteConfirmed: true,
      stats: optimisticStats,
      progression: progression
        ? addEventsToProgression(
            progression,
            existing.pendingEvents,
            optimisticStats,
          )
        : existing.progression,
    };
  }
  const profileId = derivedId ?? mintProfileId();
  return {
    profileId,
    checkpointOwnerId: profileId,
    accessCode,
    publicId,
    authUserId: sessionUserId,
    accountLinked: response.accountLinked ?? true,
    pendingNickname: null,
    remoteConfirmed: true,
    stats: response.profile,
    progression,
    pendingEvents: [],
    knownEventIds: [],
  };
}

/**
 * A server response only ever adds the public id: once known it is immutable,
 * so a profile whose queue never drains still learns the id from any sync,
 * rename or refresh response instead of staying null forever.
 */
export function mergeProfilePublicId(
  profile: StoredProfileV3,
  responsePublicId: unknown,
): string | null {
  return profile.publicId ?? normalizeProfilePublicId(responsePublicId);
}

/**
 * Forgetting a profile with a queue would drop unsynced runs, so it is refused
 * unless the caller forces it. The forced path is the escape hatch for an
 * account profile whose session is gone for good and can never drain.
 */
export function canForgetProfile(
  profile: StoredProfileV3 | null,
  force = false,
): boolean {
  if (!profile) return false;
  return force || profile.pendingEvents.length === 0;
}

export type BearerProfileAuthorization =
  | { kind: "ready"; authUserId: string | null; publicId: string | null }
  | { kind: "mismatch" };

/**
 * Decides whether the current bearer session may act on an account-adopted
 * profile. A vault can hold profiles from several accounts, so a session for
 * account Y must never write account X's queued runs into X's server player.
 * Nothing here mutates the profile: a mismatch simply refuses.
 */
export async function authorizeBearerProfile(
  profile: StoredProfileV3,
  accessToken: string,
  probeSession: (accessToken: string) => Promise<AdoptableProfileResponse>,
): Promise<BearerProfileAuthorization> {
  const sessionUserId = readAccessTokenSubject(accessToken);
  if (profile.authUserId !== null) {
    return sessionUserId !== null && sessionUserId === profile.authUserId
      ? {
          kind: "ready",
          authUserId: profile.authUserId,
          publicId: profile.publicId,
        }
      : { kind: "mismatch" };
  }
  // Profiles adopted before authUserId existed fall back to the public id the
  // read-only session endpoint reports, and adopt the user id once it matches.
  const session = await probeSession(accessToken);
  const sessionPublicId = normalizeProfilePublicId(session.profilePublicId);
  if (profile.publicId !== null && sessionPublicId !== profile.publicId) {
    return { kind: "mismatch" };
  }
  return {
    kind: "ready",
    authUserId: sessionUserId,
    publicId: profile.publicId ?? sessionPublicId,
  };
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

async function postProfile(
  request: HookStatsRequest,
  accessToken: string | null = null,
): Promise<AdoptableProfileResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
  }
  const response = await fetchGameStats(request.action, {
    body: JSON.stringify(request),
    headers,
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
  const rawProfilePublicId = (result as { profilePublicId?: unknown })
    .profilePublicId;
  let profilePublicId: string | undefined;
  if (rawProfilePublicId !== undefined) {
    const normalized = normalizeProfilePublicId(rawProfilePublicId);
    if (!normalized) {
      throw new GameStatsClientError(
        request.action,
        "invalid_response",
        "The statistics service returned an invalid profile id.",
      );
    }
    profilePublicId = normalized;
  }
  const rawAccountLinked = (result as { accountLinked?: unknown })
    .accountLinked;
  if (rawAccountLinked !== undefined && typeof rawAccountLinked !== "boolean") {
    throw new GameStatsClientError(
      request.action,
      "invalid_response",
      "The statistics service returned an invalid link status.",
    );
  }
  return {
    profile: result.profile,
    ...(accessCode ? { accessCode } : {}),
    ...(result.recorded === undefined ? {} : { recorded: result.recorded }),
    ...(progression ? { progression } : {}),
    ...(profilePublicId ? { profilePublicId } : {}),
    ...(rawAccountLinked === undefined
      ? {}
      : { accountLinked: rawAccountLinked }),
  };
}

async function postSync(
  events: GameSyncEvent[],
  credentials: { accessCode: string | null; accessToken: string | null },
): Promise<SyncResponse & { profilePublicId?: string }> {
  // The credential matrix forbids mixing: either the access code or the bearer
  // token identifies the profile, never both.
  const request: HookStatsRequest =
    credentials.accessCode !== null
      ? { action: "sync", accessCode: credentials.accessCode, events }
      : { action: "sync", events };
  const result = (await postProfile(
    request,
    credentials.accessCode !== null ? null : credentials.accessToken,
  )) as Partial<SyncResponse> & { profilePublicId?: string };
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
  getAccessToken,
  isRunActive,
}: UseGameStatsOptions): UseGameStatsResult {
  const storeRef = useRef<StoredGameStatsV3>(emptyStoredGameStatsV3());
  const leaderboardRef = useRef<LeaderboardEntry[]>([]);
  const mountedRef = useRef(false);
  const languageRef = useRef(language);
  const getAccessTokenRef = useRef(getAccessToken);
  const isRunActiveRef = useRef(isRunActive);
  const pendingAdoptionRef = useRef<{
    response: AdoptableProfileResponse;
    authUserId: string | null;
  } | null>(null);
  const syncPromiseRef = useRef<Promise<void> | null>(null);
  const syncAgainRef = useRef(false);
  const [snapshot, setSnapshot] = useState<HookSnapshot>({
    activeProfileId: null,
    leaderboard: [],
    pendingCount: 0,
    profile: null,
    profileOwnerId: null,
    profiles: [],
    progression: null,
  });
  const [status, setStatus] = useState<GameStatsSyncStatus>("loading");
  const [error, setError] = useState<GameStatsError | null>(null);
  const [accountConflict, setAccountConflict] =
    useState<GameStatsAccountConflict | null>(null);

  const publishStore = useCallback(
    (
      update: (current: StoredGameStatsV3) => StoredGameStatsV3,
      persist = true,
    ) => {
      const next = update(storeRef.current);
      if (persist) {
        try {
          writeStoredGameStatsV3(next);
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

  const acquireAccessToken = useCallback(async (): Promise<string | null> => {
    const provider = getAccessTokenRef.current;
    if (!provider) return null;
    try {
      return (await provider()) ?? null;
    } catch {
      return null;
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
      let active = activeProfileOf(storeRef.current);
      if (active) {
        const profileId = active.profileId;
        const accessCode = active.accessCode;
        let accessToken: string | null = null;
        if (accessCode === null) {
          // Account-adopted profile: the injected token provider is the only
          // credential. Without a session the queue stays untouched.
          accessToken = await acquireAccessToken();
          if (!accessToken) {
            if (mountedRef.current) {
              setError({
                code: "auth_session_missing",
                message: "Sign in to sync this account profile.",
                operation: "sync",
              });
              setStatus("error");
            }
            return;
          }
          const authorization = await authorizeBearerProfile(
            active,
            accessToken,
            (token) => postProfile({ action: "session" }, token),
          );
          if (authorization.kind === "mismatch") {
            // A session for another account must not touch this queue: nothing
            // is sent, nothing is dropped, the player just has to sign back in.
            if (mountedRef.current) {
              setError({
                code: "auth_session_mismatch",
                message:
                  "This profile belongs to a different account. Sign in with that account to sync it.",
                operation: "sync",
              });
              setStatus("error");
            }
            return;
          }
          if (
            authorization.authUserId !== active.authUserId ||
            authorization.publicId !== active.publicId
          ) {
            // The verified owner is recorded once so later passes compare the
            // session directly instead of probing again.
            publishStore((current) =>
              updateProfileInStore(current, profileId, (profile) => ({
                ...profile,
                authUserId: profile.authUserId ?? authorization.authUserId,
                publicId: profile.publicId ?? authorization.publicId,
              })),
            );
            if (storeRef.current.activeProfileId !== profileId) {
              syncAgainRef.current = true;
              return;
            }
            active = activeProfileOf(storeRef.current) ?? active;
          }
        }

        const wasRemoteConfirmed = active.remoteConfirmed;
        const submittedNickname = active.stats.nickname;
        const hasPendingChanges =
          active.pendingNickname !== null || active.pendingEvents.length > 0;
        const shouldCreate = !wasRemoteConfirmed && accessCode !== null;
        const shouldRefresh = wasRemoteConfirmed && !hasPendingChanges;

        if (shouldCreate || shouldRefresh) {
          const response = shouldCreate
            ? await postProfile({
                action: "create",
                accessCode: accessCode as string,
                nickname: submittedNickname,
                language: languageRef.current,
              })
            : accessCode !== null
              ? await postProfile({ action: "connect", accessCode })
              : await postProfile({ action: "session" }, accessToken);

          publishStore((current) =>
            updateProfileInStore(current, profileId, (profile) => {
              const latestNickname = profile.stats.nickname;
              const needsRename = wasRemoteConfirmed
                ? profile.pendingNickname
                : latestNickname !== submittedNickname
                  ? latestNickname
                  : null;
              const remoteStats = {
                ...response.profile,
                nickname: needsRename ?? response.profile.nickname,
              };
              const optimisticStats = addEventsToStats(
                remoteStats,
                profile.pendingEvents,
              );
              return {
                ...profile,
                accessCode:
                  profile.accessCode !== null
                    ? normalizeAccessCode(
                        response.accessCode ?? profile.accessCode,
                      )
                    : response.accessCode !== undefined
                      ? normalizeAccessCode(response.accessCode)
                      : null,
                publicId: mergeProfilePublicId(
                  profile,
                  response.profilePublicId,
                ),
                accountLinked: response.accountLinked ?? profile.accountLinked,
                pendingNickname: needsRename,
                remoteConfirmed: true,
                stats: optimisticStats,
                progression: response.progression
                  ? addEventsToProgression(
                      response.progression,
                      profile.pendingEvents,
                      optimisticStats,
                    )
                  : profile.progression,
              };
            }),
          );
          if (storeRef.current.activeProfileId !== profileId) {
            syncAgainRef.current = true;
            return;
          }
          active = activeProfileOf(storeRef.current);
        }

        if (active?.pendingNickname) {
          const nickname = active.pendingNickname;
          const response =
            accessCode !== null
              ? await postProfile({ action: "rename", accessCode, nickname })
              : await postProfile(
                  { action: "rename", nickname },
                  accessToken,
                );
          publishStore((current) =>
            updateProfileInStore(current, profileId, (profile) => {
              const hasNewerRename = profile.pendingNickname !== nickname;
              const latestNickname = hasNewerRename
                ? profile.stats.nickname
                : response.profile.nickname;
              return {
                ...profile,
                // A profile whose queue never drains would otherwise keep the
                // public id null forever and later duplicate itself.
                publicId: mergeProfilePublicId(
                  profile,
                  response.profilePublicId,
                ),
                pendingNickname: hasNewerRename
                  ? profile.pendingNickname
                  : null,
                stats: addEventsToStats(
                  { ...response.profile, nickname: latestNickname },
                  profile.pendingEvents,
                ),
                progression: response.progression ?? profile.progression,
              };
            }),
          );
          if (storeRef.current.activeProfileId !== profileId) {
            syncAgainRef.current = true;
            return;
          }
        }

        while (true) {
          const currentActive = activeProfileOf(storeRef.current);
          if (
            !currentActive ||
            currentActive.profileId !== profileId ||
            !currentActive.pendingEvents[0]
          ) {
            break;
          }
          const storedEvents = currentActive.pendingEvents.slice(
            0,
            MAX_GAME_SYNC_EVENTS,
          );
          const response = await postSync(storedEvents, {
            accessCode,
            accessToken,
          });
          publishStore((current) =>
            updateProfileInStore(current, profileId, (profile) => {
              const completedIds = new Set(
                response.results.map((result) => result.eventId),
              );
              const pendingEvents = profile.pendingEvents.filter(
                (event) => !completedIds.has(event.eventId),
              );
              const nickname =
                profile.pendingNickname ?? response.profile.nickname;
              const optimisticStats = addEventsToStats(
                { ...response.profile, nickname },
                pendingEvents,
              );
              return {
                ...profile,
                // Same reason as the rename handler: the drain response is the
                // only place a busy profile ever learns its public id.
                publicId: mergeProfilePublicId(
                  profile,
                  response.profilePublicId,
                ),
                pendingEvents,
                stats: optimisticStats,
                progression: response.progression
                  ? addEventsToProgression(
                      response.progression,
                      pendingEvents,
                      optimisticStats,
                    )
                  : profile.progression,
              };
            }),
          );
          if (storeRef.current.activeProfileId !== profileId) {
            syncAgainRef.current = true;
            return;
          }
        }
      }

      publishLeaderboard(await getLeaderboard());
      if (mountedRef.current) {
        setStatus(
          activeProfileOf(storeRef.current)?.remoteConfirmed === false
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
  }, [acquireAccessToken, publishLeaderboard, publishStore]);

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
      if (activeProfileOf(storeRef.current)) {
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
      const profileId = profileOwnerIdFromAccessCode(accessCode);
      const stats = emptyPlayerStats(validatedNickname.value);
      publishStore((current) =>
        upsertProfileInStore(
          current,
          {
            profileId,
            checkpointOwnerId: profileId,
            accessCode,
            publicId: null,
            authUserId: null,
            accountLinked: false,
            pendingNickname: null,
            remoteConfirmed: false,
            stats,
            progression: null,
            pendingEvents: [],
            knownEventIds: [],
          },
          true,
        ),
      );
      if (mountedRef.current) {
        setStatus("local-only");
        setError(null);
      }
      requestSync();
      return { ...stats, accessCode, accountLinked: false, publicId: null };
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
      if (activeProfileOf(storeRef.current)) {
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
        const derivedId = profileOwnerIdFromAccessCode(accessCode);
        const publicId = response.profilePublicId ?? null;
        const accountLinked = response.accountLinked ?? false;
        publishStore((current) => {
          // Reconnecting a profile that already lives in the vault updates it
          // in place; the pending offline queue and checkpoint id survive.
          const existing =
            (publicId
              ? current.profiles.find(
                  (profile) => profile.publicId === publicId,
                )
              : undefined) ??
            current.profiles.find(
              (profile) => profile.profileId === derivedId,
            );
          if (existing) {
            const optimisticStats = addEventsToStats(
              response.profile,
              existing.pendingEvents,
            );
            return upsertProfileInStore(
              current,
              {
                ...existing,
                accessCode: existing.accessCode ?? accessCode,
                publicId: existing.publicId ?? publicId,
                accountLinked: accountLinked || existing.accountLinked,
                remoteConfirmed: true,
                stats: optimisticStats,
                progression: isPlayerProgression(response.progression)
                  ? addEventsToProgression(
                      response.progression,
                      existing.pendingEvents,
                      optimisticStats,
                    )
                  : existing.progression,
              },
              true,
            );
          }
          return upsertProfileInStore(
            current,
            {
              profileId: derivedId,
              checkpointOwnerId: derivedId,
              accessCode,
              publicId,
              // The legacy code flow never carries a bearer session.
              authUserId: null,
              accountLinked,
              pendingNickname: null,
              remoteConfirmed: true,
              stats: response.profile,
              progression: isPlayerProgression(response.progression)
                ? response.progression
                : null,
              pendingEvents: [],
              knownEventIds: [],
            },
            true,
          );
        });
        if (mountedRef.current) {
          setStatus("synced");
          setError(null);
        }
        requestSync();
        return {
          ...response.profile,
          accessCode,
          accountLinked,
          publicId,
        };
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
      const active = activeProfileOf(storeRef.current);
      if (!active) {
        throw new GameStatsClientError(
          "rename",
          "profile_missing",
          "Create or connect a profile first.",
        );
      }
      publishStore((current) =>
        updateProfileInStore(current, active.profileId, (profile) => ({
          ...profile,
          pendingNickname: profile.remoteConfirmed
            ? validatedNickname.value
            : null,
          stats: {
            ...profile.stats,
            nickname: validatedNickname.value,
            updatedAt: new Date().toISOString(),
          },
        })),
      );
      if (mountedRef.current) {
        setStatus(
          activeProfileOf(storeRef.current)?.remoteConfirmed
            ? "syncing"
            : "local-only",
        );
        setError(null);
      }
      requestSync();
    },
    [publishStore, requestSync],
  );

  const forgetProfile = useCallback((options?: { force?: boolean }) => {
    const active = activeProfileOf(storeRef.current);
    if (!canForgetProfile(active, options?.force)) {
      // Unsynced runs are never dropped silently; forcing is the only way out
      // for a profile whose session is permanently gone.
      if (active && mountedRef.current) {
        setError({
          code: "pending_events",
          message: "This profile still has runs waiting to sync.",
          operation: "storage",
        });
      }
      return;
    }
    try {
      // Only the v3 vault changes; the retained v1/v2 values are never
      // touched again — the empty v3 store is the durable tombstone.
      publishStore((current) => forgetActiveProfileInStore(current));
    } catch {
      return;
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
      const active = activeProfileOf(storeRef.current);
      if (!validatedRun.ok || !active) return "invalid";
      if (
        expectedProfileOwnerId &&
        active.checkpointOwnerId !== expectedProfileOwnerId
      ) {
        return "profile-mismatch";
      }
      if (
        active.knownEventIds.includes(validatedRun.value.runId) ||
        active.pendingEvents.some(
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
        publishStore((current) =>
          updateProfileInStore(current, active.profileId, (profile) => {
            const nextStats = addRunToStats(
              profile.stats,
              validatedRun.value,
            );
            const baseProgression =
              profile.progression ??
              addEventsToProgression(
                null,
                profile.pendingEvents,
                profile.stats,
              );
            return {
              ...profile,
              knownEventIds: [
                ...profile.knownEventIds,
                validatedRun.value.runId,
              ].slice(-MAX_REMEMBERED_RUN_IDS),
              pendingEvents: [...profile.pendingEvents, event],
              stats: nextStats,
              progression: addRunToProgression(
                baseProgression,
                validatedRun.value,
                nextStats,
              ),
            };
          }),
        );
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

  const switchProfile = useCallback(
    (profileId: string): boolean => {
      // Switching mid-run would attribute the run's checkpoint and events to
      // the wrong profile; GamePanel blocks the UI and this guards the API.
      if (isRunActiveRef.current?.()) return false;
      if (
        !storeRef.current.profiles.some(
          (profile) => profile.profileId === profileId,
        )
      ) {
        return false;
      }
      if (storeRef.current.activeProfileId === profileId) return true;
      try {
        publishStore((current) =>
          current.profiles.some((profile) => profile.profileId === profileId)
            ? { ...current, activeProfileId: profileId }
            : current,
        );
      } catch {
        return false;
      }
      if (mountedRef.current) {
        setStatus(
          activeProfileOf(storeRef.current)?.remoteConfirmed === false
            ? "local-only"
            : "syncing",
        );
        setError(null);
      }
      requestSync();
      return true;
    },
    [publishStore, requestSync],
  );

  const adoptSessionProfile = useCallback(
    (
      response: AdoptableProfileResponse,
      authUserId?: string | null,
    ): AdoptProfileResult => {
      const sessionUserId = authUserId ?? null;
      const target = buildAdoptedProfile(
        storeRef.current,
        response,
        sessionUserId,
      );
      const active = activeProfileOf(storeRef.current);
      if (active && active.profileId !== target.profileId) {
        // Never merge and never overwrite: the player decides which profile
        // stays active; both stay in the vault either way.
        pendingAdoptionRef.current = { response, authUserId: sessionUserId };
        setAccountConflict({ accountProfile: profileSummary(target) });
        return "conflict";
      }
      // Mid-run the entry is stored but never activated: switching the active
      // profile would attribute the running game to the wrong profile.
      const activate = !isRunActiveRef.current?.();
      publishStore((current) =>
        upsertProfileInStore(
          current,
          buildAdoptedProfile(current, response, sessionUserId),
          activate,
        ),
      );
      if (mountedRef.current) {
        setStatus("syncing");
        setError(null);
      }
      requestSync();
      return "adopted";
    },
    [publishStore, requestSync],
  );

  const resolveConflict = useCallback(
    (choice: ConflictResolution) => {
      const pendingAdoption = pendingAdoptionRef.current;
      pendingAdoptionRef.current = null;
      setAccountConflict(null);
      if (!pendingAdoption) return;
      try {
        publishStore((current) =>
          upsertProfileInStore(
            current,
            buildAdoptedProfile(
              current,
              pendingAdoption.response,
              pendingAdoption.authUserId,
            ),
            // Same mid-run rule as adoption: store the entry, keep the run's
            // profile active until it ends.
            choice === "use-account" && !isRunActiveRef.current?.(),
          ),
        );
      } catch {
        return;
      }
      if (choice === "use-account") {
        if (mountedRef.current) {
          setStatus("syncing");
          setError(null);
        }
        requestSync();
      }
    },
    [publishStore, requestSync],
  );

  const linkActiveProfile = useCallback(async (): Promise<LinkProfileResult> => {
    const active = activeProfileOf(storeRef.current);
    if (!active) {
      throw new GameStatsClientError(
        "link",
        "profile_missing",
        "Create or connect a profile first.",
      );
    }
    if (active.accessCode === null) {
      throw new GameStatsClientError(
        "link",
        "access_code_missing",
        "This profile is already managed by the account.",
      );
    }
    const accessToken = await acquireAccessToken();
    if (!accessToken) {
      throw new GameStatsClientError(
        "link",
        "auth_session_missing",
        "Sign in before linking this profile.",
      );
    }
    const profileId = active.profileId;
    const request: LinkRequestBody = {
      action: "link",
      accessCode: active.accessCode,
    };
    const response = await fetchGameStats("link", {
      body: JSON.stringify(request),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      method: "POST",
    });
    const body = await readResponseBody(response);
    if (response.ok) {
      const raw = (body ?? {}) as {
        status?: unknown;
        profilePublicId?: unknown;
      };
      const publicId = normalizeProfilePublicId(raw.profilePublicId);
      publishStore((current) =>
        updateProfileInStore(current, profileId, (profile) => ({
          ...profile,
          accountLinked: true,
          publicId: profile.publicId ?? publicId,
        })),
      );
      return raw.status === "already-linked" ? "already-linked" : "linked";
    }
    const apiError = (body ?? {}) as Partial<ErrorResponse>;
    if (apiError.code === "ACCOUNT_PROFILE_CONFLICT") return "account-conflict";
    if (apiError.code === "PROFILE_ACCOUNT_CONFLICT") return "profile-conflict";
    throw new GameStatsClientError(
      "link",
      typeof apiError.code === "string" ? apiError.code : "request_failed",
      typeof apiError.error === "string" ? apiError.error : "Request failed.",
    );
  }, [acquireAccessToken, publishStore]);

  const unlinkActiveProfile = useCallback(async (): Promise<void> => {
    const active = activeProfileOf(storeRef.current);
    if (!active) {
      throw new GameStatsClientError(
        "unlink",
        "profile_missing",
        "Create or connect a profile first.",
      );
    }
    if (active.accessCode === null) {
      throw new GameStatsClientError(
        "unlink",
        "access_code_missing",
        "Unlinking requires the profile code.",
      );
    }
    const accessToken = await acquireAccessToken();
    if (!accessToken) {
      throw new GameStatsClientError(
        "unlink",
        "auth_session_missing",
        "Sign in before unlinking this profile.",
      );
    }
    const profileId = active.profileId;
    const request: UnlinkRequestBody = {
      action: "unlink",
      accessCode: active.accessCode,
    };
    const response = await fetchGameStats("unlink", {
      body: JSON.stringify(request),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      method: "POST",
    });
    const body = await readResponseBody(response);
    if (!response.ok) {
      const apiError = (body ?? {}) as Partial<ErrorResponse>;
      throw new GameStatsClientError(
        "unlink",
        typeof apiError.code === "string" ? apiError.code : "request_failed",
        typeof apiError.error === "string" ? apiError.error : "Request failed.",
      );
    }
    publishStore((current) =>
      updateProfileInStore(current, profileId, (profile) => ({
        ...profile,
        accountLinked: false,
      })),
    );
  }, [acquireAccessToken, publishStore]);

  useEffect(() => {
    languageRef.current = language;
    getAccessTokenRef.current = getAccessToken;
    isRunActiveRef.current = isRunActive;
  }, [language, getAccessToken, isRunActive]);

  useEffect(() => {
    mountedRef.current = true;
    const { store, migrated } = readStoredGameStats();
    storeRef.current = store;
    if (migrated) {
      try {
        writeStoredGameStatsV3(store);
      } catch {
        // Keep the migrated in-memory store and retry persistence later.
      }
    }
    setSnapshot(toHookSnapshot(store, leaderboardRef.current));
    setStatus(
      typeof navigator !== "undefined" && !navigator.onLine
        ? "offline"
        : activeProfileOf(store)?.remoteConfirmed === false
          ? "local-only"
          : "loading",
    );

    const handleOnline = () => void retrySync();
    const handleOffline = () => setStatus("offline");
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY_V3) return;
      try {
        // Read-modify-write: re-read localStorage for the freshest committed
        // value instead of trusting the possibly stale event payload.
        let onDisk: StoredGameStatsV3 | null = null;
        try {
          const raw = window.localStorage.getItem(STORAGE_KEY_V3);
          onDisk = raw
            ? sanitizeStoredGameStatsV3(JSON.parse(raw) as unknown)
            : emptyStoredGameStatsV3();
        } catch {
          onDisk = null;
        }
        const incoming =
          onDisk ??
          (event.newValue
            ? sanitizeStoredGameStatsV3(JSON.parse(event.newValue) as unknown)
            : emptyStoredGameStatsV3());
        const merged = mergeStoredGameStatsV3(storeRef.current, incoming);
        // Persist only when this tab contributes data the blob lacks;
        // activeProfileId is per-tab state and must not ping-pong writes.
        const shouldPersist =
          JSON.stringify(merged.profiles) !==
          JSON.stringify(incoming.profiles);
        publishStore(() => merged, shouldPersist);
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
    switchProfile,
    adoptSessionProfile,
    linkActiveProfile,
    unlinkActiveProfile,
    accountConflict,
    resolveConflict,
  };
}
