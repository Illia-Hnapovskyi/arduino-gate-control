import type { RunSnapshot } from "./persistence.ts";
import { selectUpgradeChoices } from "./powerUps.ts";
import { createGameWorld, type GameWorld } from "./runtime.ts";
import { createWavePlan } from "./waves.ts";

export function checkpointGameWorld(
  world: GameWorld,
  nowMs: number,
  profileOwnerId: string | null = null,
): RunSnapshot {
  if (world.status !== "upgrade") {
    throw new Error("Only a safe between-wave state can be checkpointed.");
  }
  return {
    version: 2,
    createdAtMs: Math.max(0, Math.round(nowMs - world.activeDurationMs)),
    savedAtMs: Math.max(0, Math.round(nowMs)),
    profileOwnerId,
    run: {
      runId: world.runId,
      mode: world.mode,
      difficulty: world.difficulty,
      seed: world.seed,
      rngState: world.rngState,
      nextEntityId: world.nextEntityId,
      wave: world.wave,
      sector: world.sector,
      phase: "upgrade",
      activeDurationMs: world.activeDurationMs,
      elapsedMs: world.elapsedMs,
      waveElapsedMs: world.waveElapsedMs,
      score: Math.floor(world.score / 10) * 10,
      lives: Math.max(1, world.player.lives),
      shield: world.player.shield,
      energy: world.player.energy,
      controller: world.controller,
      controllerSources: [...world.controllerSources],
      upgradeStacks: { ...world.upgradeStacks },
      upgradeChoices: [...world.upgradeChoices],
      equippedPowerUp: world.equippedPowerUp,
      powerStates: Object.fromEntries(
        Object.entries(world.powerStates).map(([id, state]) => [
          id,
          state ? { ...state } : state,
        ]),
      ),
      playerTimers: {
        invulnerableUntilMs: world.player.invulnerableUntilMs,
        fireCooldownUntilMs: world.player.fireCooldownUntilMs,
        droneCooldownUntilMs: world.player.droneCooldownUntilMs,
        missileCooldownUntilMs: world.player.missileCooldownUntilMs,
      },
      metrics: {
        ...world.metrics,
        powerUpsUsed: [...world.metrics.powerUpsUsed],
        powerUpsCollectedById: { ...world.metrics.powerUpsCollectedById },
        powerUpsActivatedById: { ...world.metrics.powerUpsActivatedById },
        sectors: world.metrics.sectors.map((sector) => ({ ...sector })),
      },
    },
  };
}

export function restoreGameWorld(snapshot: RunSnapshot) {
  const run = snapshot.run;
  const world = createGameWorld(run.runId, run.mode, run.difficulty, 0);
  world.seed = run.seed;
  world.rngState = run.rngState;
  world.nextEntityId = run.nextEntityId;
  world.wave = run.wave;
  world.sector = run.sector;
  world.wavePlan = createWavePlan({
    mode: run.mode,
    difficulty: run.difficulty,
    wave: run.wave,
    seed: run.seed,
  });
  world.waveElapsedMs = run.waveElapsedMs;
  world.wavePhase = "rest";
  world.activeDurationMs = run.activeDurationMs;
  world.elapsedMs = run.elapsedMs;
  world.score = run.score;
  world.controller = run.controller;
  world.controllerSources = [...run.controllerSources];
  world.upgradeStacks = { ...run.upgradeStacks };
  world.equippedPowerUp = run.equippedPowerUp;
  world.metrics = {
    ...run.metrics,
    powerUpsUsed: [...run.metrics.powerUpsUsed],
    powerUpsCollectedById: { ...run.metrics.powerUpsCollectedById },
    powerUpsActivatedById: { ...run.metrics.powerUpsActivatedById },
    sectors: run.metrics.sectors.map((sector) => ({ ...sector })),
  };
  world.player.lives = run.lives;
  const shieldStacks = run.upgradeStacks["reinforced-shield"] ?? 0;
  world.player.maxShield = 100 + shieldStacks * 25;
  world.player.shield = run.shield;
  world.player.energy = run.energy;
  world.player.invulnerableUntilMs = run.playerTimers.invulnerableUntilMs;
  world.player.fireCooldownUntilMs = run.playerTimers.fireCooldownUntilMs;
  world.player.droneCooldownUntilMs = run.playerTimers.droneCooldownUntilMs;
  world.player.missileCooldownUntilMs = run.playerTimers.missileCooldownUntilMs;
  world.powerStates = Object.fromEntries(
    Object.entries(run.powerStates).map(([id, state]) => [
      id,
      state ? { ...state } : state,
    ]),
  );
  world.status = "upgrade";
  world.upgradeChoices =
    run.upgradeChoices.length > 0
      ? [...run.upgradeChoices]
      : selectUpgradeChoices({
          seed: world.seed,
          wave: world.wave,
          mode: world.mode,
          owned: world.upgradeStacks,
        });
  world.events = [];
  return world;
}
