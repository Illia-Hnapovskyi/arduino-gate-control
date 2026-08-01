import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRunSnapshot,
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
