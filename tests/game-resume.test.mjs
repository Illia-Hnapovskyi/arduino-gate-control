import assert from "node:assert/strict";
import test from "node:test";

import {
  RUN_SNAPSHOT_STORAGE_KEY,
  canResumeRun,
  clearRunSnapshot,
  loadRunSnapshot,
  parseRunSnapshot,
  runSnapshotStorageKey,
  saveRunSnapshot,
  serializeRunSnapshot,
} from "../app/game/persistence.ts";
import { checkpointGameWorld, restoreGameWorld } from "../app/game/resume.ts";
import {
  createGameWorld,
  selectUpgrade,
  stepGameWorld,
} from "../app/game/runtime.ts";
import { createWavePlan } from "../app/game/waves.ts";

test("safe checkpoints restore canonical deterministic state without rerolls or grants", () => {
  const world = createGameWorld(
    "run_0123456789ABCDEFGHJK",
    "expedition",
    "pilot",
    42,
  );
  world.status = "upgrade";
  world.wave = 3;
  world.sector = "meteor-belt";
  world.wavePlan = createWavePlan({
    mode: world.mode,
    difficulty: world.difficulty,
    wave: world.wave,
    seed: world.seed,
  });
  world.waveElapsedMs = world.wavePlan.totalDurationMs;
  world.wavePhase = "rest";
  world.activeDurationMs = 92_500.5;
  world.elapsedMs = 92_500.5;
  world.score = 2_400;
  world.player.lives = 2;
  world.upgradeStacks = { "reinforced-shield": 2, "rapid-fire": 1 };
  world.upgradeChoices = ["rapid-fire", "repair-nanites", "twin-shot"];
  world.equippedPowerUp = "time";
  world.metrics.powerUpsCollected = 1;
  world.metrics.powerUpsCollectedById.time = 1;
  world.rngState = 0x1234_abcd;
  world.nextEntityId = 37;
  world.player.maxShield = 150;
  world.player.shield = 47.5;
  world.player.energy = 23.25;
  world.player.invulnerableUntilMs = 93_100.5;
  world.player.fireCooldownUntilMs = 92_610.5;
  world.player.droneCooldownUntilMs = 92_900.5;
  world.player.missileCooldownUntilMs = 93_200.5;
  world.controller = "mixed";
  world.controllerSources = ["arduino", "touch"];
  world.powerStates.time = {
    id: "time",
    activatedAtMs: 89_000.5,
    activeUntilMs: 94_000.5,
    cooldownUntilMs: 113_000.5,
  };
  world.metrics.livesLost = 4;
  world.metrics.sectors = [
    {
      wave: 1,
      sectorId: "starfield",
      durationMs: 30_000,
      completed: true,
      livesLost: 1,
    },
    {
      wave: 2,
      sectorId: "nebula",
      durationMs: 30_500,
      completed: true,
      livesLost: 2,
    },
    {
      wave: 3,
      sectorId: "meteor-belt",
      durationMs: 32_000.5,
      completed: true,
      livesLost: 1,
    },
  ];
  world.events = [];

  const snapshot = checkpointGameWorld(
    world,
    200_000,
    "profile_0123456789abcdef",
  );
  const persisted = parseRunSnapshot(
    serializeRunSnapshot(snapshot),
    200_001,
  );
  assert.ok(persisted);
  const restored = restoreGameWorld(persisted);
  assert.equal(persisted.profileOwnerId, "profile_0123456789abcdef");
  assert.equal(restored.runId, world.runId);
  assert.equal(restored.seed, world.seed);
  assert.equal(restored.rngState, world.rngState);
  assert.equal(restored.nextEntityId, world.nextEntityId);
  assert.equal(restored.status, "upgrade");
  assert.equal(restored.score, 2_400);
  assert.equal(restored.player.lives, 2);
  assert.equal(restored.player.maxShield, 150);
  assert.equal(restored.player.shield, 47.5);
  assert.equal(restored.player.energy, 23.25);
  assert.equal(restored.equippedPowerUp, "time");
  assert.equal(restored.metrics.powerUpsCollectedById.time, 1);
  assert.equal(restored.activeDurationMs, 92_500.5);
  assert.equal(restored.elapsedMs, 92_500.5);
  assert.deepEqual(restored.upgradeChoices, world.upgradeChoices);
  assert.deepEqual(restored.powerStates, world.powerStates);
  assert.deepEqual(restored.controllerSources, world.controllerSources);
  assert.deepEqual(restored.metrics, world.metrics);
  assert.deepEqual(
    {
      invulnerableUntilMs: restored.player.invulnerableUntilMs,
      fireCooldownUntilMs: restored.player.fireCooldownUntilMs,
      droneCooldownUntilMs: restored.player.droneCooldownUntilMs,
      missileCooldownUntilMs: restored.player.missileCooldownUntilMs,
    },
    {
      invulnerableUntilMs: world.player.invulnerableUntilMs,
      fireCooldownUntilMs: world.player.fireCooldownUntilMs,
      droneCooldownUntilMs: world.player.droneCooldownUntilMs,
      missileCooldownUntilMs: world.player.missileCooldownUntilMs,
    },
  );

  assert.equal(selectUpgrade(world, "rapid-fire"), true);
  assert.equal(selectUpgrade(restored, "rapid-fire"), true);
  const nextInput = {
    moveX: -0.4,
    moveY: 0.2,
    fire: true,
    power: false,
    controller: "touch",
  };
  stepGameWorld(world, nextInput, 250);
  stepGameWorld(restored, nextInput, 250);
  assert.deepEqual(restored, world);
});

test("active combat cannot be mistaken for a safe resumable checkpoint", () => {
  const world = createGameWorld(
    "run_0123456789ABCDEFGHJK",
    "survival",
    "cadet",
    7,
  );
  assert.throws(() => checkpointGameWorld(world, 10_000), /between-wave/);
});

const OWNER_A = "profile_0123456789abcdef";
const OWNER_B = "profile_fedcba9876543210";

function parkedSnapshot(ownerId, runId = "run_0123456789ABCDEFGHJK", savedAtMs = 200_000) {
  const world = createGameWorld(runId, "expedition", "pilot", 42);
  world.status = "upgrade";
  // Matches what sanitization derives, so a snapshot equals its round-trip.
  world.controllerSources = ["keyboard"];
  return checkpointGameWorld(world, savedAtMs, ownerId);
}

function memoryStorage(initial = []) {
  const values = new Map(initial);
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("checkpoint slots are per profile owner and never overlap", () => {
  assert.equal(runSnapshotStorageKey(null), RUN_SNAPSHOT_STORAGE_KEY);
  assert.equal(
    runSnapshotStorageKey(OWNER_A),
    `${RUN_SNAPSHOT_STORAGE_KEY}:${OWNER_A}`,
  );

  const storage = memoryStorage();
  const runA = parkedSnapshot(OWNER_A, "run_AAAAAAAAAAAAAAAAAAAA");
  const runB = parkedSnapshot(OWNER_B, "run_BBBBBBBBBBBBBBBBBBBB");
  assert.equal(saveRunSnapshot(storage, runA), true);
  assert.equal(saveRunSnapshot(storage, runB), true);

  assert.equal(storage.values.has(runSnapshotStorageKey(OWNER_A)), true);
  assert.equal(storage.values.has(runSnapshotStorageKey(OWNER_B)), true);
  assert.equal(storage.values.has(RUN_SNAPSHOT_STORAGE_KEY), false);
  assert.deepEqual(loadRunSnapshot(storage, 200_001, OWNER_A), runA);
  assert.deepEqual(loadRunSnapshot(storage, 200_001, OWNER_B), runB);
  assert.equal(loadRunSnapshot(storage, 200_001), null);
  assert.equal(canResumeRun(runA), true);
});

test("a parked checkpoint survives while another profile plays and clears its own", () => {
  const storage = memoryStorage();
  const parkedByA = parkedSnapshot(OWNER_A, "run_AAAAAAAAAAAAAAAAAAAA");
  assert.equal(saveRunSnapshot(storage, parkedByA), true);

  // Profile B runs, checkpoints and finishes: only B's slot is ever touched.
  const parkedByB = parkedSnapshot(OWNER_B, "run_BBBBBBBBBBBBBBBBBBBB");
  assert.equal(saveRunSnapshot(storage, parkedByB), true);
  assert.equal(clearRunSnapshot(storage, OWNER_B), true);
  assert.equal(loadRunSnapshot(storage, 200_001, OWNER_B), null);
  assert.deepEqual(loadRunSnapshot(storage, 200_001, OWNER_A), parkedByA);

  // B starting a fresh run is not blocked by, and does not destroy, A's checkpoint.
  const secondRunByB = parkedSnapshot(OWNER_B, "run_CCCCCCCCCCCCCCCCCCCC");
  assert.equal(saveRunSnapshot(storage, secondRunByB), true);
  assert.deepEqual(loadRunSnapshot(storage, 200_001, OWNER_A), parkedByA);
  assert.equal(clearRunSnapshot(storage, OWNER_A), true);
  assert.equal(loadRunSnapshot(storage, 200_001, OWNER_A), null);
  assert.deepEqual(loadRunSnapshot(storage, 200_001, OWNER_B), secondRunByB);
});

test("a legacy checkpoint is migrated only by the owner it names", () => {
  const legacyRun = parkedSnapshot(OWNER_A, "run_AAAAAAAAAAAAAAAAAAAA");
  const serialized = serializeRunSnapshot(legacyRun);
  const storage = memoryStorage([[RUN_SNAPSHOT_STORAGE_KEY, serialized]]);

  // A foreign profile neither reads nor rewrites nor deletes it.
  assert.equal(loadRunSnapshot(storage, 200_001, OWNER_B), null);
  assert.equal(storage.values.get(RUN_SNAPSHOT_STORAGE_KEY), serialized);
  assert.equal(clearRunSnapshot(storage, OWNER_B), true);
  assert.equal(storage.values.get(RUN_SNAPSHOT_STORAGE_KEY), serialized);
  assert.equal(storage.values.has(runSnapshotStorageKey(OWNER_B)), false);

  // The named owner adopts it into its own slot exactly once.
  assert.deepEqual(loadRunSnapshot(storage, 200_001, OWNER_A), legacyRun);
  assert.equal(storage.values.has(RUN_SNAPSHOT_STORAGE_KEY), false);
  assert.equal(
    storage.values.get(runSnapshotStorageKey(OWNER_A)),
    serialized,
  );
  assert.deepEqual(loadRunSnapshot(storage, 200_001, OWNER_A), legacyRun);

  // An unowned legacy checkpoint stays visible only while no profile is active.
  const orphan = serializeRunSnapshot(parkedSnapshot(null));
  const orphanStorage = memoryStorage([[RUN_SNAPSHOT_STORAGE_KEY, orphan]]);
  assert.equal(loadRunSnapshot(orphanStorage, 200_001, OWNER_A), null);
  assert.equal(orphanStorage.values.get(RUN_SNAPSHOT_STORAGE_KEY), orphan);
  assert.equal(clearRunSnapshot(orphanStorage, OWNER_A), true);
  assert.equal(orphanStorage.values.get(RUN_SNAPSHOT_STORAGE_KEY), orphan);
  assert.equal(loadRunSnapshot(orphanStorage, 200_001)?.profileOwnerId, null);
  assert.equal(clearRunSnapshot(orphanStorage), true);
  assert.equal(orphanStorage.values.has(RUN_SNAPSHOT_STORAGE_KEY), false);
});

test("per-owner slots keep the age limit and stay fail-soft on storage errors", () => {
  const week = 7 * 24 * 60 * 60 * 1000;
  const stale = parkedSnapshot(OWNER_A, "run_AAAAAAAAAAAAAAAAAAAA", 200_000);
  const storage = memoryStorage([
    [runSnapshotStorageKey(OWNER_A), serializeRunSnapshot(stale)],
    [RUN_SNAPSHOT_STORAGE_KEY, serializeRunSnapshot(stale)],
  ]);
  // Expired own slot resolves to nothing and never falls back to the legacy slot.
  assert.equal(loadRunSnapshot(storage, 200_001 + week, OWNER_A), null);
  assert.equal(storage.values.has(RUN_SNAPSHOT_STORAGE_KEY), true);
  assert.deepEqual(loadRunSnapshot(storage, 200_001, OWNER_A), stale);

  const failingStorage = {
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem() {
      throw new Error("quota exceeded");
    },
    removeItem() {
      throw new Error("storage unavailable");
    },
  };
  assert.equal(saveRunSnapshot(failingStorage, stale), false);
  assert.equal(loadRunSnapshot(failingStorage, 200_001, OWNER_A), null);
  assert.equal(clearRunSnapshot(failingStorage, OWNER_A), false);

  // A readable-but-unreadable-legacy storage still clears the requested slot.
  const removed = [];
  const halfBrokenStorage = {
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem: () => undefined,
    removeItem: (key) => removed.push(key),
  };
  assert.equal(clearRunSnapshot(halfBrokenStorage, OWNER_A), true);
  assert.deepEqual(removed, [runSnapshotStorageKey(OWNER_A)]);
});
