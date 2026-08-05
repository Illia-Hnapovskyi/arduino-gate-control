import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  authorizeBearerProfile,
  buildAdoptedProfile,
  canForgetProfile,
  emptyStoredGameStatsV3,
  forgetActiveProfileInStore,
  isOrphanedProfile,
  mergeProfilePublicId,
  mergeStoredGameStatsV2,
  mergeStoredGameStatsV3,
  migrateStoredGameStatsV1,
  migrateStoredGameStatsV2ToV3,
  mintLocalProfileId,
  profileOwnerIdFromAccessCode,
  readAccessTokenSubject,
  sanitizeStoredGameStatsV2,
  sanitizeStoredGameStatsV3,
  shouldPersistMergedGameStats,
  upsertProfileInStore,
} from "../app/useGameStats.ts";

const hookSource = readFileSync(
  new URL("../app/useGameStats.ts", import.meta.url),
  "utf8",
);

const accessCode = "01234-56789-ABCDE-FGHJK";
const normalizedAccessCode = "0123456789ABCDEFGHJK";
const secondAccessCode = "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ";
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

function fullProgression() {
  return {
    schemaVersion: 2,
    serverRevision: 7,
    totals: {
      enemiesDestroyed: 42,
      bossesDefeated: 3,
      shotsFired: 500,
      shotsHit: 250,
      longestCombo: 12,
      powerupsCollected: 9,
      longestRunMs: 300_000,
      wins: 1,
      arduinoRuns: 2,
      bestAccuracyPermille: 500,
    },
    modes: [
      {
        modeId: "classic",
        difficultyId: "pilot",
        gamesPlayed: 4,
        totalScore: 2_000,
        highScore: 900,
        highestWave: 5,
        enemiesDestroyed: 42,
        bossesDefeated: 3,
        totalDurationMs: 400_000,
        wins: 1,
      },
    ],
    powers: [{ powerId: "shield", collectedCount: 4, activatedCount: 3 }],
    achievements: [
      { achievementId: "first_run", progress: 4, unlockedAt: "2026-08-01T09:00:00.000Z" },
    ],
    unlocks: [
      { unlockId: "achievement:first_run", unlockedAt: "2026-08-01T09:00:00.000Z" },
    ],
    settings: {
      revision: 3,
      musicVolume: 55,
      effectsVolume: 65,
      screenShake: false,
      reducedMotion: true,
    },
  };
}

function v2StoreWithEverything() {
  const migrated = migrateStoredGameStatsV1({
    version: 1,
    profile: legacyProfile(),
    pendingRuns: [pendingRun],
    knownRunIds: [pendingRun.runId, "run_KKKKKKKKKKKKKKKKKKKK"],
  });
  return {
    ...migrated,
    profile: {
      ...migrated.profile,
      progression: fullProgression(),
    },
  };
}

const accountUserId = "11112222-3333-4444-8555-666677778888";
const otherAccountUserId = "99998888-7777-6666-8555-444433332222";

function accessTokenFor(userId) {
  // Unsigned stand-in: the client only reads `sub` as a local ownership guard.
  const encode = (value) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "ES256", typ: "JWT" })}.${encode({
    sub: userId,
    aud: "authenticated",
  })}.signature`;
}

function eventFor(run) {
  return migrateStoredGameStatsV1({
    version: 1,
    profile: legacyProfile(),
    pendingRuns: [run],
    knownRunIds: [],
  }).pendingEvents[0];
}

function accountProfileFixture(overrides = {}) {
  return {
    profileId: "profile_00112233445566aa",
    checkpointOwnerId: "profile_00112233445566aa",
    accessCode: null,
    publicId: "0f1e2d3c-4b5a-4978-8765-43210fedcba9",
    authUserId: accountUserId,
    accountLinked: true,
    pendingNickname: null,
    remoteConfirmed: true,
    stats: {
      nickname: "Account Ace",
      gamesPlayed: 3,
      totalScore: 900,
      highScore: 400,
      highestLevel: 3,
      totalDurationMs: 60_000,
      updatedAt: "2026-08-02T10:00:00.000Z",
    },
    progression: null,
    pendingEvents: [],
    knownEventIds: [],
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
  assert.equal(migrated.profile?.accessCode, normalizedAccessCode);
  assert.equal(migrated.profile?.remoteConfirmed, false);
  assert.equal(migrated.profile?.pendingNickname, "Nova Pilot");
  assert.deepEqual(migrated.profile?.stats, legacy.profile.stats);
  assert.equal(migrated.profile?.progression, null);
  assert.equal(migrated.pendingEvents.length, 1);
  assert.equal(migrated.pendingEvents[0].eventId, pendingRun.runId);
  assert.deepEqual(migrated.knownEventIds, [pendingRun.runId]);
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
  assert.deepEqual(sanitizeStoredGameStatsV3({ version: 2 }), {
    version: 3,
    activeProfileId: null,
    profiles: [],
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

test("v2 to v3 migration is zero-loss for every stored field", () => {
  const v2 = v2StoreWithEverything();
  const before = structuredClone(v2);
  const migrated = migrateStoredGameStatsV2ToV3(v2);

  assert.deepEqual(v2, before, "migration must be pure");
  assert.equal(migrated.version, 3);
  assert.equal(migrated.profiles.length, 1);
  const profile = migrated.profiles[0];
  const expectedOwner = profileOwnerIdFromAccessCode(accessCode);
  assert.equal(migrated.activeProfileId, profile.profileId);
  assert.equal(profile.profileId, expectedOwner);
  assert.equal(
    profile.checkpointOwnerId,
    expectedOwner,
    "existing checkpoints must keep resolving after the migration",
  );

  // Byte-for-byte preservation of every v2 field.
  assert.equal(
    JSON.stringify(profile.accessCode),
    JSON.stringify(v2.profile.accessCode),
  );
  assert.equal(
    JSON.stringify(profile.pendingNickname),
    JSON.stringify(v2.profile.pendingNickname),
  );
  assert.equal(profile.remoteConfirmed, v2.profile.remoteConfirmed);
  assert.equal(JSON.stringify(profile.stats), JSON.stringify(v2.profile.stats));
  assert.equal(
    JSON.stringify(profile.progression),
    JSON.stringify(v2.profile.progression),
  );
  assert.equal(
    JSON.stringify(profile.pendingEvents),
    JSON.stringify(v2.pendingEvents),
  );
  assert.equal(
    JSON.stringify(profile.knownEventIds),
    JSON.stringify(v2.knownEventIds),
  );

  // New account fields start inert, which makes the profile orphaned.
  assert.equal(profile.publicId, null);
  assert.equal(profile.authUserId, null);
  assert.equal(profile.accountLinked, false);
  assert.equal(isOrphanedProfile(profile), true);
});

test("v1 to v3 chain keeps the queue and derives the same checkpoint owner", () => {
  const migrated = migrateStoredGameStatsV2ToV3(
    migrateStoredGameStatsV1({
      version: 1,
      profile: legacyProfile({ pendingNickname: null, remoteConfirmed: true }),
      pendingRuns: [pendingRun, { ...pendingRun, runId: "bad id" }],
      knownRunIds: [pendingRun.runId, "bad id"],
    }),
  );
  assert.equal(migrated.profiles.length, 1);
  const profile = migrated.profiles[0];
  assert.equal(profile.accessCode, normalizedAccessCode);
  assert.equal(profile.checkpointOwnerId, profileOwnerIdFromAccessCode(accessCode));
  assert.equal(profile.remoteConfirmed, true);
  assert.equal(profile.progression, null);
  assert.equal(profile.pendingEvents.length, 1);
  assert.equal(profile.pendingEvents[0].eventId, pendingRun.runId);
  assert.deepEqual(profile.knownEventIds, [pendingRun.runId]);
});

test("empty v2 store migrates to an empty v3 tombstone", () => {
  assert.deepEqual(
    migrateStoredGameStatsV2ToV3({
      version: 2,
      profile: null,
      pendingEvents: [],
      knownEventIds: [],
    }),
    { version: 3, activeProfileId: null, profiles: [] },
  );
});

test("v3 sanitizer round-trips a full store byte-for-byte", () => {
  const codeProfileStore = migrateStoredGameStatsV2ToV3(v2StoreWithEverything());
  const store = upsertProfileInStore(
    codeProfileStore,
    accountProfileFixture(),
    false,
  );
  const sanitized = sanitizeStoredGameStatsV3(
    JSON.parse(JSON.stringify(store)),
  );
  // deepEqual, not JSON string equality: the progression validator rebuilds
  // objects with canonical key order while keeping every value identical.
  assert.deepEqual(sanitized, store);
});

test("v3 sanitizer drops garbage but keeps valid vault entries", () => {
  const store = migrateStoredGameStatsV2ToV3(v2StoreWithEverything());
  const sanitized = sanitizeStoredGameStatsV3({
    version: 3,
    activeProfileId: store.activeProfileId,
    profiles: [
      store.profiles[0],
      { profileId: "profile_zzz", accessCode: "nope" },
      42,
    ],
  });
  assert.equal(sanitized.profiles.length, 1);
  assert.equal(sanitized.profiles[0].profileId, store.profiles[0].profileId);
  assert.equal(sanitized.activeProfileId, store.activeProfileId);

  const dangling = sanitizeStoredGameStatsV3({
    version: 3,
    activeProfileId: "profile_ffffffffffffffff",
    profiles: [store.profiles[0]],
  });
  assert.equal(dangling.activeProfileId, null);
});

test("union merge keeps profiles the incoming blob lacks", () => {
  const codeStore = migrateStoredGameStatsV2ToV3(v2StoreWithEverything());
  const accountStore = upsertProfileInStore(
    emptyStoredGameStatsV3(),
    accountProfileFixture(),
    true,
  );

  const merged = mergeStoredGameStatsV3(codeStore, accountStore);
  assert.equal(merged.profiles.length, 2);
  assert.deepEqual(
    merged.profiles.map((profile) => profile.profileId).sort(),
    [codeStore.profiles[0].profileId, accountProfileFixture().profileId].sort(),
  );
  assert.equal(
    merged.activeProfileId,
    codeStore.activeProfileId,
    "the current tab keeps its own active profile",
  );

  const reverse = mergeStoredGameStatsV3(accountStore, codeStore);
  assert.deepEqual(
    reverse.profiles.map((profile) => profile.profileId),
    merged.profiles.map((profile) => profile.profileId),
    "profile union is order-canonical for cross-tab convergence",
  );
  assert.equal(reverse.activeProfileId, accountStore.activeProfileId);
});

test("union merge unions each shared profile's offline queue", () => {
  const base = migrateStoredGameStatsV2ToV3(
    migrateStoredGameStatsV1({
      version: 1,
      profile: legacyProfile({ pendingNickname: null }),
      pendingRuns: [pendingRun],
      knownRunIds: [pendingRun.runId],
    }),
  );
  const secondRun = {
    runId: "run_0123456789ABCDEFGHJL",
    score: 700,
    level: 2,
    durationMs: 25_000,
  };
  const incoming = migrateStoredGameStatsV2ToV3(
    migrateStoredGameStatsV1({
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
    }),
  );

  const merged = mergeStoredGameStatsV3(base, incoming);
  assert.equal(merged.profiles.length, 1);
  const profile = merged.profiles[0];
  assert.deepEqual(
    profile.pendingEvents.map((event) => event.eventId).sort(),
    [pendingRun.runId, secondRun.runId].sort(),
  );
  assert.equal(profile.stats.gamesPlayed, 2);
  assert.equal(profile.stats.totalScore, 1_200);
  assert.equal(
    profile.checkpointOwnerId,
    base.profiles[0].checkpointOwnerId,
    "merging never re-mints the checkpoint owner id",
  );
  assert.deepEqual(
    mergeStoredGameStatsV3(incoming, base),
    merged,
    "simultaneous tabs must converge on one durable queue regardless of event order",
  );
  assert.deepEqual(
    mergeStoredGameStatsV3(merged, base),
    merged,
    "replaying a storage event must not double-count its optimistic totals",
  );
});

test("adoption and a later merge never re-mint the checkpoint owner id", () => {
  const publicId = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";
  const migrated = migrateStoredGameStatsV2ToV3(v2StoreWithEverything());
  // A legacy profile that had already learned its server id before codes were
  // retired: signing in with the owning account reaches it again.
  const original = { ...migrated.profiles[0], publicId };
  const store = upsertProfileInStore(migrated, original, true);

  const adopted = buildAdoptedProfile(
    store,
    {
      profile: { ...original.stats, nickname: "Renamed Ace" },
      profilePublicId: publicId,
      accountLinked: true,
    },
    accountUserId,
  );
  assert.equal(adopted.profileId, original.profileId);
  assert.equal(
    adopted.checkpointOwnerId,
    original.checkpointOwnerId,
    "adoption must never recompute the checkpoint owner id",
  );
  assert.equal(
    adopted.accessCode,
    original.accessCode,
    "a retained legacy code is kept as-is, never rewritten",
  );
  assert.equal(adopted.authUserId, accountUserId);
  assert.equal(
    isOrphanedProfile(adopted),
    false,
    "an account owns it again, so it can sync with the bearer token",
  );
  assert.equal(adopted.publicId, publicId);
  assert.equal(adopted.accountLinked, true);
  assert.equal(
    JSON.stringify(adopted.pendingEvents),
    JSON.stringify(original.pendingEvents),
    "adoption keeps the offline queue",
  );

  // A later merge with the updated entry still keeps the original owner id.
  const merged = mergeStoredGameStatsV3(
    store,
    upsertProfileInStore(emptyStoredGameStatsV3(), adopted, true),
  );
  assert.equal(merged.profiles.length, 1);
  assert.equal(merged.profiles[0].checkpointOwnerId, original.checkpointOwnerId);
  assert.equal(merged.profiles[0].publicId, publicId);
});

test("account-adopted profiles work without an access code", () => {
  const response = {
    profile: {
      nickname: "Account Ace",
      gamesPlayed: 3,
      totalScore: 900,
      highScore: 400,
      highestLevel: 3,
      totalDurationMs: 60_000,
      updatedAt: "2026-08-02T10:00:00.000Z",
    },
    profilePublicId: "0f1e2d3c-4b5a-4978-8765-43210fedcba9",
    accountLinked: true,
  };
  const adopted = buildAdoptedProfile(emptyStoredGameStatsV3(), response);
  assert.equal(adopted.accessCode, null);
  assert.match(adopted.profileId, /^profile_[0-9a-f]{16}$/);
  assert.equal(
    adopted.checkpointOwnerId,
    adopted.profileId,
    "account profiles mint one random checkpoint owner id",
  );
  assert.equal(adopted.publicId, response.profilePublicId);
  assert.equal(adopted.accountLinked, true);
  assert.equal(adopted.remoteConfirmed, true);
  assert.deepEqual(adopted.pendingEvents, []);

  // Two mints never collide with each other in practice and match the format.
  const other = buildAdoptedProfile(emptyStoredGameStatsV3(), response);
  assert.match(other.profileId, /^profile_[0-9a-f]{16}$/);
  assert.match(mintLocalProfileId(), /^profile_[0-9a-f]{16}$/);
});

test("adoption dedups by publicId before creating a new vault entry", () => {
  const existing = accountProfileFixture();
  const store = upsertProfileInStore(emptyStoredGameStatsV3(), existing, true);
  const adopted = buildAdoptedProfile(store, {
    profile: { ...existing.stats, gamesPlayed: 5, totalScore: 1_500 },
    profilePublicId: existing.publicId,
    accountLinked: true,
  });
  assert.equal(
    adopted.profileId,
    existing.profileId,
    "same publicId updates in place instead of duplicating",
  );
  assert.equal(adopted.checkpointOwnerId, existing.checkpointOwnerId);
  assert.equal(adopted.stats.gamesPlayed, 5);
  const next = upsertProfileInStore(store, adopted, true);
  assert.equal(next.profiles.length, 1);
});

test("forgetting removes only the active profile and keeps the rest of the vault", () => {
  const codeStore = migrateStoredGameStatsV2ToV3(v2StoreWithEverything());
  const account = accountProfileFixture();
  const store = upsertProfileInStore(codeStore, account, false);
  assert.equal(store.activeProfileId, codeStore.profiles[0].profileId);

  const forgotten = forgetActiveProfileInStore(store);
  assert.equal(forgotten.activeProfileId, null);
  assert.equal(forgotten.profiles.length, 1);
  assert.equal(forgotten.profiles[0].profileId, account.profileId);
  assert.equal(
    JSON.stringify(forgotten.profiles[0]),
    JSON.stringify(account),
    "the surviving vault entry is untouched",
  );

  // Without an active profile the forget is a no-op — never a mass wipe.
  assert.equal(forgetActiveProfileInStore(forgotten), forgotten);
  const empty = forgetActiveProfileInStore(
    upsertProfileInStore(emptyStoredGameStatsV3(), account, true),
  );
  assert.deepEqual(empty, { version: 3, activeProfileId: null, profiles: [] });
});

test("a bearer session from another account is refused without sending anything", async () => {
  const queued = eventFor(pendingRun);
  const profile = accountProfileFixture({
    pendingEvents: [queued],
    knownEventIds: [queued.eventId],
  });
  const before = structuredClone(profile);
  let probes = 0;
  const authorization = await authorizeBearerProfile(
    profile,
    accessTokenFor(otherAccountUserId),
    async () => {
      probes += 1;
      return { profile: profile.stats };
    },
  );

  assert.deepEqual(authorization, { kind: "mismatch" });
  assert.equal(probes, 0, "a mismatching session must not reach the server");
  assert.deepEqual(profile, before, "the queue and the vault entry stay intact");

  // The matching session is allowed and keeps the stored owner.
  assert.deepEqual(
    await authorizeBearerProfile(
      profile,
      accessTokenFor(accountUserId),
      async () => {
        probes += 1;
        return { profile: profile.stats };
      },
    ),
    { kind: "ready", authUserId: accountUserId, publicId: profile.publicId },
  );
  assert.equal(probes, 0, "a known owner is verified locally, without a probe");

  // An opaque token cannot prove ownership, so it is refused as well.
  assert.deepEqual(
    await authorizeBearerProfile(profile, "not-a-jwt", async () => {
      probes += 1;
      return { profile: profile.stats };
    }),
    { kind: "mismatch" },
  );
  assert.equal(probes, 0);
  assert.equal(readAccessTokenSubject(accessTokenFor(accountUserId)), accountUserId);
  assert.equal(readAccessTokenSubject("not-a-jwt"), null);
});

test("profiles stored before authUserId fall back to the public id and adopt the owner", async () => {
  const legacyAccountProfile = accountProfileFixture({ authUserId: null });
  const probeCalls = [];
  const ready = await authorizeBearerProfile(
    legacyAccountProfile,
    accessTokenFor(accountUserId),
    async (token) => {
      probeCalls.push(token);
      return {
        profile: legacyAccountProfile.stats,
        profilePublicId: legacyAccountProfile.publicId,
      };
    },
  );
  assert.deepEqual(ready, {
    kind: "ready",
    authUserId: accountUserId,
    publicId: legacyAccountProfile.publicId,
  });
  assert.equal(probeCalls.length, 1, "the read-only session probe resolves it");

  const foreign = await authorizeBearerProfile(
    legacyAccountProfile,
    accessTokenFor(otherAccountUserId),
    async () => ({
      profile: legacyAccountProfile.stats,
      profilePublicId: "aaaabbbb-cccc-4ddd-8eee-ffff00001111",
    }),
  );
  assert.deepEqual(
    foreign,
    { kind: "mismatch" },
    "another account's player id never adopts this profile",
  );
});

test("adoption records the verified session owner", () => {
  const adopted = buildAdoptedProfile(
    emptyStoredGameStatsV3(),
    {
      profile: accountProfileFixture().stats,
      profilePublicId: accountProfileFixture().publicId,
      accountLinked: true,
    },
    accountUserId,
  );
  assert.equal(adopted.authUserId, accountUserId);
  assert.equal(
    buildAdoptedProfile(emptyStoredGameStatsV3(), {
      profile: accountProfileFixture().stats,
    }).authUserId,
    null,
    "without a session id the profile stays unowned",
  );
});

test("a response public id is persisted for a profile whose queue never drains", () => {
  const queued = eventFor(pendingRun);
  const busy = accountProfileFixture({
    publicId: null,
    pendingEvents: [queued],
    knownEventIds: [queued.eventId],
  });
  const responsePublicId = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";
  assert.equal(mergeProfilePublicId(busy, responsePublicId), responsePublicId);
  assert.equal(
    mergeProfilePublicId(busy, "AAAABBBB-CCCC-4DDD-8EEE-FFFF00001111"),
    responsePublicId,
    "the server value is normalized before it is stored",
  );
  assert.equal(mergeProfilePublicId(busy, undefined), null);
  assert.equal(mergeProfilePublicId(busy, "nope"), null);
  const known = accountProfileFixture();
  assert.equal(
    mergeProfilePublicId(known, responsePublicId),
    known.publicId,
    "a known public id is immutable",
  );

  // Both drain paths must persist it, otherwise the profile duplicates later.
  const renameSection = hookSource.slice(
    hookSource.indexOf('{ action: "rename", nickname }'),
    hookSource.indexOf("while (true)"),
  );
  const drainSection = hookSource.slice(hookSource.indexOf("await postSync("));
  assert.match(renameSection, /publicId: mergeProfilePublicId\(/);
  assert.match(drainSection, /publicId: mergeProfilePublicId\(/);
});

test("merging collapses duplicate entries that share a public id", () => {
  const publicId = "0f1e2d3c-4b5a-4978-8765-43210fedcba9";
  const firstRun = eventFor(pendingRun);
  const secondRun = eventFor({
    ...pendingRun,
    runId: "run_0123456789ABCDEFGHJL",
    score: 700,
  });
  const original = accountProfileFixture({
    publicId,
    pendingEvents: [firstRun],
    knownEventIds: [firstRun.eventId],
  });
  // The same server profile, adopted again before the queue ever drained.
  const duplicate = accountProfileFixture({
    profileId: "profile_ffee00112233445a",
    checkpointOwnerId: "profile_ffee00112233445a",
    publicId,
    pendingEvents: [secondRun],
    knownEventIds: [secondRun.eventId],
  });
  const current = upsertProfileInStore(
    emptyStoredGameStatsV3(),
    original,
    true,
  );
  const incoming = upsertProfileInStore(
    emptyStoredGameStatsV3(),
    duplicate,
    true,
  );

  const merged = mergeStoredGameStatsV3(current, incoming);
  assert.equal(merged.profiles.length, 1, "one server profile, one vault entry");
  const survivor = merged.profiles[0];
  assert.equal(survivor.profileId, original.profileId);
  assert.equal(
    survivor.checkpointOwnerId,
    original.checkpointOwnerId,
    "collapsing never rewrites the surviving checkpoint owner id",
  );
  assert.equal(survivor.publicId, publicId);
  assert.deepEqual(
    survivor.pendingEvents.map((event) => event.eventId).sort(),
    [firstRun.eventId, secondRun.eventId].sort(),
    "both queues survive the collapse",
  );
  assert.deepEqual(
    survivor.knownEventIds.slice().sort(),
    [firstRun.eventId, secondRun.eventId].sort(),
  );
  assert.equal(merged.activeProfileId, original.profileId);

  const reverse = mergeStoredGameStatsV3(incoming, current);
  assert.deepEqual(
    reverse,
    merged,
    "the collapse is direction-independent so cross-tab merges converge",
  );
  assert.deepEqual(
    mergeStoredGameStatsV3(merged, incoming),
    merged,
    "replaying the duplicate must not resurrect it",
  );

  // A tab whose active profile was the duplicate follows it to the survivor.
  const activeOnDuplicate = mergeStoredGameStatsV3(
    { ...current, activeProfileId: duplicate.profileId, profiles: [duplicate] },
    { ...incoming, activeProfileId: null, profiles: [original] },
  );
  assert.equal(activeOnDuplicate.profiles.length, 1);
  assert.equal(activeOnDuplicate.activeProfileId, original.profileId);

  // Entries without a public id are still only unioned by profileId.
  const withoutPublicId = mergeStoredGameStatsV3(
    upsertProfileInStore(
      emptyStoredGameStatsV3(),
      accountProfileFixture({ publicId: null }),
      true,
    ),
    upsertProfileInStore(
      emptyStoredGameStatsV3(),
      accountProfileFixture({
        profileId: "profile_ffee00112233445a",
        checkpointOwnerId: "profile_ffee00112233445a",
        publicId: null,
      }),
      true,
    ),
  );
  assert.equal(withoutPublicId.profiles.length, 2);
});

test("adopting during an active run stores the entry without switching profiles", () => {
  const codeStore = migrateStoredGameStatsV2ToV3(v2StoreWithEverything());
  const adopted = buildAdoptedProfile(
    codeStore,
    {
      profile: accountProfileFixture().stats,
      profilePublicId: accountProfileFixture().publicId,
      accountLinked: true,
    },
    accountUserId,
  );
  // activate === false is what the hook passes while a run is active.
  const stored = upsertProfileInStore(codeStore, adopted, false);
  assert.equal(stored.profiles.length, 2, "the account entry joins the vault");
  assert.equal(
    stored.activeProfileId,
    codeStore.activeProfileId,
    "the running game keeps its own profile",
  );
  assert.equal(
    JSON.stringify(
      stored.profiles.find(
        (profile) => profile.profileId === codeStore.profiles[0].profileId,
      ),
    ),
    JSON.stringify(codeStore.profiles[0]),
    "the running profile is untouched",
  );

  const adoptSection = hookSource.slice(
    hookSource.indexOf("const adoptProfileResponse ="),
    hookSource.indexOf("const createAccountProfile ="),
  );
  assert.match(
    adoptSection,
    /upsertProfileInStore\(current, adopted, !isRunActiveRef\.current\?\.\(\)\)/,
    "both adoption entry points share the mid-run guard",
  );
});

test("forcing forget releases an account profile whose session is gone", () => {
  const queued = eventFor(pendingRun);
  const stuck = accountProfileFixture({
    pendingEvents: [queued],
    knownEventIds: [queued.eventId],
  });
  const other = accountProfileFixture({
    profileId: "profile_ffee00112233445a",
    checkpointOwnerId: "profile_ffee00112233445a",
    publicId: "aaaabbbb-cccc-4ddd-8eee-ffff00001111",
  });
  assert.equal(canForgetProfile(stuck), false, "queued runs are never dropped");
  assert.equal(canForgetProfile(stuck, true), true);
  assert.equal(canForgetProfile(accountProfileFixture()), true);
  assert.equal(canForgetProfile(null, true), false, "nothing to forget");

  const store = upsertProfileInStore(
    upsertProfileInStore(emptyStoredGameStatsV3(), other, false),
    stuck,
    true,
  );
  const forgotten = forgetActiveProfileInStore(store);
  assert.equal(forgotten.activeProfileId, null);
  assert.deepEqual(
    forgotten.profiles.map((profile) => profile.profileId),
    [other.profileId],
    "forcing removes the stuck profile and nothing else",
  );
  assert.equal(
    JSON.stringify(forgotten.profiles[0]),
    JSON.stringify(other),
    "the surviving vault entry keeps its queue and checkpoint owner",
  );
  assert.match(hookSource, /canForgetProfile\(active, options\?\.force\)/);
});

test("a migrated code profile is orphaned: readable, queued, never sent", () => {
  const store = migrateStoredGameStatsV2ToV3(v2StoreWithEverything());
  const orphan = store.profiles[0];
  assert.equal(isOrphanedProfile(orphan), true);
  assert.equal(orphan.accessCode, normalizedAccessCode, "the code still loads");
  assert.equal(orphan.authUserId, null);
  assert.equal(orphan.stats.gamesPlayed, 1, "its statistics stay readable");
  assert.equal(orphan.pendingEvents.length, 1, "its queue stays intact");
  assert.equal(isOrphanedProfile(accountProfileFixture()), false);
  assert.equal(
    isOrphanedProfile(accountProfileFixture({ accessCode: normalizedAccessCode })),
    false,
    "a legacy profile an account owns still syncs with the bearer token",
  );
  assert.equal(store.profiles.some(isOrphanedProfile), true);
  assert.match(
    hookSource,
    /hasOrphanedProfiles: store\.profiles\.some\(isOrphanedProfile\)/,
    "the snapshot flag covers the whole vault, not just the active profile",
  );

  // The sync pass skips such a profile entirely and reports the retired code.
  const syncSection = hookSource.slice(
    hookSource.indexOf("const runSyncPass = useCallback("),
    hookSource.indexOf("const retrySync = useCallback("),
  );
  assert.match(
    syncSection,
    /const retired = active !== null && isOrphanedProfile\(active\);/,
  );
  assert.match(syncSection, /if \(active && !retired\) \{/);
  assert.match(syncSection, /code: "code_login_retired"/);
});

test("no outgoing request can carry an access code", () => {
  // Everything from the request helpers down is the network layer.
  const requestSection = hookSource.slice(
    hookSource.indexOf("async function fetchGameStats("),
  );
  assert.match(
    requestSection,
    /headers\.authorization = `Bearer \$\{accessToken\}`;/,
    "the bearer token is the only credential a request carries",
  );
  assert.doesNotMatch(
    requestSection,
    /accessCode/,
    "a retained code never reaches a request body",
  );
  assert.deepEqual(
    Array.from(new Set(hookSource.match(/action: "[a-z]+"/g))).sort(),
    ['action: "create"', 'action: "rename"', 'action: "session"', 'action: "sync"'],
    "only the bearer-only actions are ever built",
  );
  assert.doesNotMatch(hookSource, /generateAccessCode/, "nothing mints a code");
  assert.doesNotMatch(
    hookSource,
    /connectProfile|linkActiveProfile|unlinkActiveProfile|resolveConflict/,
    "the code-login and linking entry points are gone",
  );
});

test("account creation needs a session and stores no code", () => {
  const createSection = hookSource.slice(
    hookSource.indexOf("const createAccountProfile = useCallback("),
    hookSource.indexOf("const renameProfile = useCallback("),
  );
  assert.match(createSection, /const accessToken = await acquireAccessToken\(\);/);
  assert.match(createSection, /"auth_session_missing"/);
  assert.match(createSection, /action: "create",/);
  assert.match(
    createSection,
    /readAccessTokenSubject\(accessToken\)/,
    "the new profile is bound to the signed-in account",
  );
  assert.doesNotMatch(createSection, /accessCode/);

  // Even a stale server echoing a code leaves the vault entry code-less.
  const created = buildAdoptedProfile(
    emptyStoredGameStatsV3(),
    {
      profile: accountProfileFixture().stats,
      accessCode,
      profilePublicId: accountProfileFixture().publicId,
      accountLinked: true,
    },
    accountUserId,
  );
  assert.equal(created.accessCode, null);
  assert.equal(isOrphanedProfile(created), false);
});

test("signing in beside an orphaned profile keeps both entries", () => {
  const store = migrateStoredGameStatsV2ToV3(v2StoreWithEverything());
  const orphan = store.profiles[0];
  const adopted = buildAdoptedProfile(
    store,
    {
      profile: accountProfileFixture().stats,
      profilePublicId: accountProfileFixture().publicId,
      accountLinked: true,
    },
    accountUserId,
  );
  assert.notEqual(
    adopted.profileId,
    orphan.profileId,
    "no credential proves the orphan belongs to this account, so it is not adopted",
  );

  const next = upsertProfileInStore(store, adopted, true);
  assert.equal(next.profiles.length, 2);
  assert.equal(next.activeProfileId, adopted.profileId);
  const keptOrphan = next.profiles.find(
    (profile) => profile.profileId === orphan.profileId,
  );
  assert.equal(
    JSON.stringify(keptOrphan),
    JSON.stringify(orphan),
    "the orphan keeps its statistics and its queue byte-for-byte",
  );
  assert.equal(next.profiles.some(isOrphanedProfile), true);
  assert.equal(
    canForgetProfile(keptOrphan),
    false,
    "its queued runs are still protected",
  );
  assert.equal(canForgetProfile(keptOrphan, true), true, "forcing is the way out");
});

test("v2 merge helpers keep their pre-v3 behavior for rollback safety", () => {
  const base = migrateStoredGameStatsV1({
    version: 1,
    profile: legacyProfile({ pendingNickname: null }),
    pendingRuns: [pendingRun],
    knownRunIds: [pendingRun.runId],
  });
  const incoming = structuredClone(base);
  assert.equal(shouldPersistMergedGameStats(base, incoming), true);
  const otherProfile = structuredClone(incoming);
  otherProfile.profile.accessCode = secondAccessCode;
  assert.equal(shouldPersistMergedGameStats(base, otherProfile), false);
  assert.deepEqual(mergeStoredGameStatsV2(base, otherProfile), base);
});
