import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeStoredGameStatsV2,
  migrateStoredGameStatsV1,
  profileOwnerIdFromAccessCode,
  sanitizeStoredGameStatsV2,
  shouldPersistMergedGameStats,
} from "../app/useGameStats.ts";

const accessCode = "01234-56789-ABCDE-FGHJK";
const pendingRun = {
  runId: "run_0123456789ABCDEFGHJK",
  score: 500,
  level: 2,
  durationMs: 25_000,
};

function legacyProfile(overrides = {}) {
  return {
    accessCode,
    pendingNickname: "Nova Pilot",
    remoteConfirmed: false,
    stats: {
      nickname: "Nova Pilot",
      gamesPlayed: 1,
      totalScore: 500,
      highScore: 500,
      highestLevel: 2,
      totalDurationMs: 25_000,
      updatedAt: "2026-08-01T10:00:00.000Z",
    },
    ...overrides,
  };
}

test("v1 migration preserves an unconfirmed profile and every valid pending run", () => {
  const legacy = {
    version: 1,
    profile: legacyProfile(),
    pendingRuns: [pendingRun],
    knownRunIds: [pendingRun.runId],
  };
  const before = structuredClone(legacy);
  const migrated = migrateStoredGameStatsV1(legacy);

  assert.deepEqual(legacy, before, "migration must be pure");
  assert.equal(migrated.version, 2);
  assert.equal(migrated.profile?.accessCode, "0123456789ABCDEFGHJK");
  assert.equal(migrated.profile?.remoteConfirmed, false);
  assert.equal(migrated.profile?.pendingNickname, "Nova Pilot");
  assert.deepEqual(migrated.profile?.stats, legacy.profile.stats);
  assert.equal(migrated.profile?.progression, null);
  assert.equal(migrated.pendingEvents.length, 1);
  assert.equal(migrated.pendingEvents[0].eventId, pendingRun.runId);
  assert.equal(migrated.pendingEvents[0].payload.modeId, "classic");
  assert.equal(migrated.pendingEvents[0].payload.difficultyId, "pilot");
  assert.deepEqual(migrated.knownEventIds, [pendingRun.runId]);
});

test("v1 migration removes malformed queue entries without discarding the profile", () => {
  const migrated = migrateStoredGameStatsV1({
    version: 1,
    profile: legacyProfile({ pendingNickname: null, remoteConfirmed: true }),
    pendingRuns: [pendingRun, { ...pendingRun, runId: "bad id" }, pendingRun],
    knownRunIds: [pendingRun.runId, "bad id"],
  });

  assert.equal(migrated.profile?.remoteConfirmed, true);
  assert.equal(migrated.pendingEvents.length, 1);
  assert.deepEqual(migrated.knownEventIds, [pendingRun.runId]);
});

test("v2 sanitizer keeps optimistic data and de-duplicates pending event IDs", () => {
  const migrated = migrateStoredGameStatsV1({
    version: 1,
    profile: legacyProfile(),
    pendingRuns: [pendingRun],
    knownRunIds: [],
  });
  const sanitized = sanitizeStoredGameStatsV2({
    ...migrated,
    pendingEvents: [migrated.pendingEvents[0], migrated.pendingEvents[0]],
    knownEventIds: [],
  });

  assert.equal(sanitized.pendingEvents.length, 1);
  assert.deepEqual(sanitized.knownEventIds, [pendingRun.runId]);
  assert.deepEqual(sanitized.profile?.stats, migrated.profile?.stats);
});

test("invalid storage versions never inherit a profile secret", () => {
  assert.deepEqual(migrateStoredGameStatsV1({ version: 0 }), {
    version: 2,
    profile: null,
    pendingEvents: [],
    knownEventIds: [],
  });
  assert.deepEqual(sanitizeStoredGameStatsV2({ version: 1 }), {
    version: 2,
    profile: null,
    pendingEvents: [],
    knownEventIds: [],
  });
});

test("profile ownership is stable without exposing the access code", () => {
  const owner = profileOwnerIdFromAccessCode(accessCode);
  assert.match(owner, /^profile_[0-9a-f]{16}$/);
  assert.equal(
    profileOwnerIdFromAccessCode("ol234 56789 abcde fghjk"),
    owner,
  );
  assert.doesNotMatch(owner, /01234|ABCDE/);
});

test("same-profile storage events merge offline queues without cross-profile replacement", () => {
  const base = migrateStoredGameStatsV1({
    version: 1,
    profile: legacyProfile({
      pendingNickname: null,
    }),
    pendingRuns: [pendingRun],
    knownRunIds: [pendingRun.runId],
  });
  const secondRun = {
    runId: "run_0123456789ABCDEFGHJL",
    score: 700,
    level: 2,
    durationMs: 25_000,
  };
  const incoming = migrateStoredGameStatsV1({
    version: 1,
    profile: legacyProfile({
      pendingNickname: null,
      stats: {
        ...legacyProfile().stats,
        totalScore: 700,
        highScore: 700,
      },
    }),
    pendingRuns: [secondRun],
    knownRunIds: [secondRun.runId],
  });
  const merged = mergeStoredGameStatsV2(base, incoming);
  assert.deepEqual(
    merged.pendingEvents.map((event) => event.eventId).sort(),
    [pendingRun.runId, secondRun.runId].sort(),
  );
  assert.equal(merged.profile?.stats.gamesPlayed, 2);
  assert.equal(merged.profile?.stats.totalScore, 1_200);
  assert.deepEqual(
    mergeStoredGameStatsV2(incoming, base),
    merged,
    "simultaneous tabs must converge on one durable queue regardless of event order",
  );
  assert.deepEqual(
    mergeStoredGameStatsV2(merged, base),
    merged,
    "replaying a storage event must not double-count its optimistic totals",
  );
  assert.equal(shouldPersistMergedGameStats(base, incoming), true);

  const otherProfile = structuredClone(incoming);
  otherProfile.profile.accessCode = "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ";
  assert.equal(shouldPersistMergedGameStats(base, otherProfile), false);
  assert.deepEqual(mergeStoredGameStatsV2(base, otherProfile), base);
  assert.equal(
    shouldPersistMergedGameStats(base, { ...incoming, profile: null }),
    false,
  );
  assert.deepEqual(
    mergeStoredGameStatsV2(base, { ...incoming, profile: null, pendingEvents: [] }),
    base,
  );
});
