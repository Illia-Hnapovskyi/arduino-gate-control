import assert from "node:assert/strict";
import test from "node:test";

import { POWER_UP_BALANCE } from "../app/game/balance.ts";
import {
  MAX_GAME_SCORE,
  activateEquippedSuperpower,
  advanceWave,
  awardScore,
  createGameWorld,
  selectUpgrade,
  snapshotGameSummary,
  spawnBoss,
  spawnEnemy,
  stepGameWorld,
} from "../app/game/runtime.ts";
import { ENEMY_ARCHETYPE_IDS } from "../app/game/types.ts";

const IDLE_INPUT = Object.freeze({
  moveX: 0,
  moveY: 0,
  fire: false,
  power: false,
});

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function hostileProjectile(world, overrides = {}) {
  return {
    id: "hostile-test-shot",
    owner: "enemy",
    kind: "orb",
    x: world.player.x,
    y: world.player.y,
    vx: 0,
    vy: 0,
    radius: 8,
    damage: 100,
    pierce: 0,
    expiresAtMs: world.elapsedMs + 2_000,
    targetId: null,
    hitCounted: false,
    hitTargetIds: [],
    color: "#ff0000",
    ...overrides,
  };
}

function playerProjectile(world, x, y, damage = 10) {
  return {
    id: "player-test-shot",
    owner: "player",
    kind: "bullet",
    x,
    y,
    vx: 0,
    vy: 0,
    radius: 5,
    damage,
    pierce: 0,
    expiresAtMs: world.elapsedMs + 2_000,
    targetId: null,
    hitCounted: false,
    hitTargetIds: [],
    color: "#ffffff",
  };
}

test("runtime replay is deterministic for a seed, inputs, and fixed steps", () => {
  const first = createGameWorld("runtime-seed-a", "survival", "pilot", 9173);
  const second = createGameWorld("runtime-seed-a", "survival", "pilot", 9173);

  for (let frame = 0; frame < 180; frame++) {
    const input = {
      moveX: Math.sin(frame / 11),
      moveY: Math.cos(frame / 17) * 0.45,
      fire: frame % 2 === 0,
      power: frame === 90,
      controller: frame < 100 ? "keyboard" : "mixed",
    };
    stepGameWorld(first, input, 50);
    stepGameWorld(second, input, 50);
  }

  assert.deepEqual(first, second);
  assert.equal(first.rngState, second.rngState);
  assert.notEqual(first.rngState, first.seed);
});

test("controller classification is run-wide and idle frames are neutral", () => {
  const arduinoOnly = createGameWorld(
    "runtime-input-a",
    "survival",
    "pilot",
    14,
  );
  stepGameWorld(
    arduinoOnly,
    { ...IDLE_INPUT, moveX: 0.5, controller: "arduino" },
    20,
  );
  assert.equal(arduinoOnly.controller, "arduino");
  assert.deepEqual(arduinoOnly.controllerSources, ["arduino"]);

  for (let frame = 0; frame < 20; frame++) {
    stepGameWorld(arduinoOnly, IDLE_INPUT, 20);
  }
  assert.equal(arduinoOnly.controller, "arduino");
  assert.deepEqual(arduinoOnly.controllerSources, ["arduino"]);

  stepGameWorld(
    arduinoOnly,
    { ...IDLE_INPUT, fire: true, controller: "keyboard" },
    20,
  );
  assert.equal(arduinoOnly.controller, "mixed");
  assert.deepEqual(arduinoOnly.controllerSources, ["arduino", "keyboard"]);

  stepGameWorld(
    arduinoOnly,
    { ...IDLE_INPUT, moveY: -1, controller: "touch" },
    20,
  );
  assert.equal(arduinoOnly.controller, "mixed");
});

test("all ten enemy roles and elite modifiers have stable runtime identities", () => {
  const world = createGameWorld("runtime-roles-a", "survival", "pilot", 72);
  const spawned = ENEMY_ARCHETYPE_IDS.map((archetype, index) =>
    spawnEnemy(world, archetype, {
      x: 55 + index * 82,
      y: 82,
      elite: archetype === "armored-asteroid",
    }),
  );

  assert.deepEqual(
    spawned.map((enemy) => enemy.archetype),
    ENEMY_ARCHETYPE_IDS,
  );
  assert.equal(new Set(spawned.map((enemy) => enemy.id)).size, 10);
  assert.equal(
    spawned.find((enemy) => enemy.archetype === "armored-asteroid")?.elite,
    true,
  );
  stepGameWorld(world, IDLE_INPUT, 20);
  assert.equal(new Set(world.enemies.map((enemy) => enemy.archetype)).size, 10);
});

test("special enemies split, shoot, hunt, support, detonate, and dash", () => {
  const splitterWorld = createGameWorld("runtime-split-a", "survival", "pilot", 1);
  const splitter = spawnEnemy(splitterWorld, "splitter-asteroid", {
    x: 300,
    y: 180,
    healthMultiplier: 0.2,
    speedMultiplier: 0,
  });
  splitter.health = 0.5;
  splitterWorld.playerProjectiles.push(
    playerProjectile(splitterWorld, splitter.x, splitter.y),
  );
  stepGameWorld(splitterWorld, IDLE_INPUT, 20);
  assert.equal(
    splitterWorld.enemies.filter((enemy) => enemy.archetype === "swift-asteroid")
      .length,
    2,
  );
  assert.equal(splitterWorld.metrics.enemiesDestroyed, 1);

  const gunnerWorld = createGameWorld("runtime-gunner-a", "survival", "pilot", 2);
  const gunner = spawnEnemy(gunnerWorld, "gunner-drone", { x: 280, y: 180 });
  gunner.fireCooldownUntilMs = 0;
  stepGameWorld(gunnerWorld, IDLE_INPUT, 20);
  assert.ok(gunnerWorld.enemyProjectiles.length > 0);

  const hunterWorld = createGameWorld("runtime-hunter-a", "survival", "pilot", 3);
  const hunter = spawnEnemy(hunterWorld, "hunter-drone", { x: 80, y: 80 });
  hunter.vx = 0;
  hunter.vy = 0;
  const beforeHunt = distance(hunter, hunterWorld.player);
  stepGameWorld(hunterWorld, IDLE_INPUT, 200);
  assert.ok(distance(hunter, hunterWorld.player) < beforeHunt);

  const supportWorld = createGameWorld("runtime-help-a", "survival", "pilot", 4);
  const ally = spawnEnemy(supportWorld, "armored-asteroid", { x: 380, y: 160 });
  ally.health = 1;
  const support = spawnEnemy(supportWorld, "support-drone", { x: 405, y: 160 });
  support.abilityCooldownUntilMs = 0;
  stepGameWorld(supportWorld, IDLE_INPUT, 20);
  assert.ok(ally.health > 1);
  assert.ok(ally.buffedUntilMs > supportWorld.elapsedMs);

  const mineWorld = createGameWorld("runtime-mine-aa", "survival", "pilot", 5);
  const mine = spawnEnemy(mineWorld, "mine", {
    x: mineWorld.player.x,
    y: mineWorld.player.y - 100,
  });
  mine.abilityCooldownUntilMs = 0;
  stepGameWorld(mineWorld, IDLE_INPUT, 20);
  assert.equal(mineWorld.enemies.includes(mine), false);
  assert.ok(mineWorld.enemyProjectiles.length >= 8);

  const cometWorld = createGameWorld("runtime-comet-a", "survival", "pilot", 6);
  const comet = spawnEnemy(cometWorld, "comet", { x: 150, y: 120 });
  comet.abilityCooldownUntilMs = 0;
  stepGameWorld(cometWorld, IDLE_INPUT, 20);
  assert.ok(comet.vy > comet.speed);
  assert.ok(cometWorld.effects.some((effect) => effect.kind === "dash"));
});

test("support drones cannot accelerate beyond their designed chase speed", () => {
  const world = createGameWorld("runtime-support-cap-a", "survival", "pilot", 41);
  const ally = spawnEnemy(world, "armored-asteroid", {
    x: 650,
    y: 160,
    speedMultiplier: 0,
  });
  ally.health = 1;
  const support = spawnEnemy(world, "support-drone", { x: 120, y: 160 });
  support.vx = 0;
  support.vy = 0;

  for (let frame = 0; frame < 500; frame++) {
    stepGameWorld(world, IDLE_INPUT, 20);
    assert.ok(
      Math.hypot(support.vx, support.vy) <= support.speed * 1.15 + 1e-9,
    );
  }
});

test("difficulty scales hostile projectile speed and damage centrally", () => {
  const projectiles = ["cadet", "pilot", "ace"].map((difficulty) => {
    const world = createGameWorld(
      `runtime-projectile-${difficulty}`,
      "survival",
      difficulty,
      44,
    );
    const gunner = spawnEnemy(world, "gunner-drone", { x: 300, y: 120 });
    gunner.fireCooldownUntilMs = 0;
    stepGameWorld(world, IDLE_INPUT, 20);
    const projectile = world.enemyProjectiles[0];
    assert.ok(projectile);
    return {
      damage: projectile.damage,
      speed: Math.hypot(projectile.vx, projectile.vy),
    };
  });

  assert.deepEqual(projectiles.map(({ damage }) => damage), [15, 20, 25]);
  assert.ok(projectiles[0].speed < projectiles[1].speed);
  assert.ok(projectiles[1].speed < projectiles[2].speed);

  const modifiedEnemies = ["cadet", "pilot", "ace"].map((difficulty) => {
    const world = createGameWorld(
      `runtime-modifier-${difficulty}`,
      "survival",
      difficulty,
      45,
    );
    const enemy = spawnEnemy(world, "armored-asteroid", {
      healthMultiplier: 2,
      speedMultiplier: 1.2,
    });
    return { health: enemy.maxHealth, speed: enemy.speed };
  });
  assert.ok(modifiedEnemies[0].health < modifiedEnemies[1].health);
  assert.ok(modifiedEnemies[1].health < modifiedEnemies[2].health);
  assert.ok(modifiedEnemies[0].speed < modifiedEnemies[1].speed);
  assert.ok(modifiedEnemies[1].speed < modifiedEnemies[2].speed);

  const bossCollisionShield = ["cadet", "pilot", "ace"].map((difficulty) => {
    const world = createGameWorld(
      `runtime-boss-contact-${difficulty}`,
      "survival",
      difficulty,
      46,
    );
    const boss = spawnBoss(world, "sentinel-array");
    boss.x = world.player.x;
    boss.y = world.player.y;
    boss.vy = 0;
    world.player.shield = 100;
    world.player.invulnerableUntilMs = 0;
    stepGameWorld(world, IDLE_INPUT, 20);
    return world.player.shield;
  });
  assert.ok(bossCollisionShield[0] > bossCollisionShield[1]);
  assert.ok(bossCollisionShield[1] > bossCollisionShield[2]);
});

test("nebula dampens hostile shots while darkness accelerates pursuit", () => {
  const projectileWorlds = ["starfield", "nebula", "dark"].map((sector) => {
    const world = createGameWorld(
      "runtime-sectorfx-a",
      "survival",
      "pilot",
      52,
    );
    world.sector = sector;
    world.enemyProjectiles.push(
      hostileProjectile(world, {
        id: `hostile-${sector}`,
        x: 100,
        y: 100,
        vx: 100,
        vy: 0,
        damage: 1,
      }),
    );
    stepGameWorld(world, IDLE_INPUT, 100);
    return world;
  });
  const [starfield, nebula, dark] = projectileWorlds.map(
    (world) => world.enemyProjectiles[0]?.x ?? 0,
  );
  assert.ok(nebula < starfield);
  assert.ok(starfield < dark);

  const regularWorld = createGameWorld(
    "runtime-darkhunt-a",
    "survival",
    "pilot",
    53,
  );
  const darkWorld = createGameWorld(
    "runtime-darkhunt-a",
    "survival",
    "pilot",
    53,
  );
  regularWorld.sector = "starfield";
  darkWorld.sector = "dark";
  const regularHunter = spawnEnemy(regularWorld, "hunter-drone", {
    x: 80,
    y: 80,
  });
  const darkHunter = spawnEnemy(darkWorld, "hunter-drone", { x: 80, y: 80 });
  regularHunter.vx = 0;
  regularHunter.vy = 0;
  darkHunter.vx = 0;
  darkHunter.vy = 0;
  stepGameWorld(regularWorld, IDLE_INPUT, 200);
  stepGameWorld(darkWorld, IDLE_INPUT, 200);
  assert.ok(
    distance(darkHunter, darkWorld.player) <
      distance(regularHunter, regularWorld.player),
  );
});

test("piercing projectiles damage each target at most once", () => {
  const world = createGameWorld("runtime-pierce-a", "survival", "pilot", 61);
  const enemy = spawnEnemy(world, "armored-asteroid", {
    x: 320,
    y: 180,
    healthMultiplier: 4,
    speedMultiplier: 0,
  });
  enemy.vx = 0;
  enemy.vy = 0;
  world.playerProjectiles.push({
    ...playerProjectile(world, enemy.x, enemy.y, 10),
    pierce: 2,
  });

  stepGameWorld(world, IDLE_INPUT, 20);
  const healthAfterFirstHit = enemy.health;
  assert.deepEqual(world.playerProjectiles[0]?.hitTargetIds, [enemy.id]);
  assert.equal(world.playerProjectiles[0]?.pierce, 1);

  stepGameWorld(world, IDLE_INPUT, 20);
  assert.equal(enemy.health, healthAfterFirstHit);
  assert.equal(world.playerProjectiles[0]?.pierce, 1);
  assert.equal(world.metrics.shotsHit, 1);
});

test("three bosses enter later phases and use distinct attacks and summons", () => {
  const cases = [
    ["sentinel-array", 3, "gunner-drone"],
    ["comet-leviathan", 3, "comet"],
    ["void-dreadnought", 4, "support-drone"],
  ];

  for (const [bossId, expectedPhase, expectedSummon] of cases) {
    const world = createGameWorld(`boss-${bossId}`, "survival", "pilot", bossId);
    const boss = spawnBoss(world, bossId);
    assert.ok(
      world.events.some(
        (event) =>
          event.type === "boss" &&
          event.action === "spawn" &&
          event.bossId === bossId,
      ),
    );
    boss.x = world.width / 2;
    boss.y = 92;
    boss.invulnerableUntilMs = 0;
    boss.health = boss.maxHealth * 0.18;
    boss.fireCooldownUntilMs = 0;
    boss.abilityCooldownUntilMs = 0;
    boss.summonCooldownUntilMs = 0;

    const emitted = [];
    for (let tick = 0; tick < 5; tick++) {
      emitted.push(...stepGameWorld(world, IDLE_INPUT, 250));
    }

    assert.equal(boss.phase, expectedPhase);
    assert.ok(
      emitted.some(
        (event) =>
          event.type === "boss" &&
          event.action === "phase" &&
          event.bossId === bossId &&
          event.phase === expectedPhase,
      ),
    );
    assert.ok(world.enemyProjectiles.length > 0, `${bossId} should attack`);
    assert.ok(
      world.enemies.some((enemy) => enemy.archetype === expectedSummon),
      `${bossId} should summon ${expectedSummon}`,
    );
    if (bossId !== "sentinel-array") {
      assert.ok(
        world.effects.some((effect) => effect.kind === "dash"),
        `${bossId} should reposition or dash`,
      );
    }
  }
});

test("each boss immediately grants its own resumable signature superpower", () => {
  const rewards = {
    "sentinel-array": "laser",
    "comet-leviathan": "time",
    "void-dreadnought": "charge",
  };
  for (const [bossId, expectedReward] of Object.entries(rewards)) {
    const world = createGameWorld(`reward-${bossId}`, "survival", "pilot", bossId);
    const boss = spawnBoss(world, bossId);
    boss.health = 1;
    boss.invulnerableUntilMs = 0;
    world.equippedPowerUp = "emp";
    world.player.energy = 100;
    assert.equal(activateEquippedSuperpower(world), true);
    assert.equal(world.boss, null);
    assert.equal(world.equippedPowerUp, expectedReward);
    assert.equal(world.metrics.powerUpsCollected, 1);
    assert.equal(world.metrics.powerUpsCollectedById[expectedReward], 1);
    assert.equal(
      world.pickups.some((pickup) => pickup.powerUpId === expectedReward),
      false,
    );
  }
});

test("superpower energy and cooldown prevent repeated activation", () => {
  const world = createGameWorld("runtime-power-a", "survival", "pilot", 17);
  world.equippedPowerUp = "laser";
  world.player.energy = 100;

  assert.equal(activateEquippedSuperpower(world), true);
  const state = world.powerStates.laser;
  assert.ok(state);
  assert.equal(world.player.energy, 100 - POWER_UP_BALANCE.laser.energyCost);
  world.player.energy = 100;
  assert.equal(activateEquippedSuperpower(world), false);
  assert.equal(world.events.at(-1)?.type, "toast");
  assert.equal(world.events.at(-1)?.id, "power-cooldown");

  world.elapsedMs = state.cooldownUntilMs;
  world.player.energy = 100;
  assert.equal(activateEquippedSuperpower(world), true);
  assert.deepEqual(world.metrics.powerUpsUsed, ["laser"]);

  const lowEnergy = createGameWorld(
    "runtime-power-b",
    "survival",
    "pilot",
    18,
  );
  lowEnergy.equippedPowerUp = "laser";
  lowEnergy.player.energy = POWER_UP_BALANCE.laser.energyCost - 1;
  assert.equal(activateEquippedSuperpower(lowEnergy), false);
  assert.equal(lowEnergy.events.at(-1)?.type, "toast");
  assert.equal(lowEnergy.events.at(-1)?.id, "power-low-energy");

  const fullRepair = createGameWorld(
    "runtime-power-repair-full",
    "survival",
    "pilot",
    19,
  );
  fullRepair.equippedPowerUp = "repair";
  assert.equal(activateEquippedSuperpower(fullRepair), false);
  assert.equal(fullRepair.events.at(-1)?.type, "toast");
  assert.equal(fullRepair.events.at(-1)?.id, "power-not-needed");
  assert.equal(fullRepair.powerStates.repair, undefined);
  assert.deepEqual(fullRepair.metrics.powerUpsUsed, []);

  fullRepair.player.shield = Math.round(fullRepair.player.maxShield * 0.2);
  assert.equal(activateEquippedSuperpower(fullRepair), true);
  assert.equal(
    fullRepair.player.shield,
    Math.round(fullRepair.player.maxShield * 0.55),
  );
});

test("every stack of parallel barrels, escort drones, and EMP capacitor has value", () => {
  const projectileCounts = [0, 1, 2].map((stacks) => {
    const world = createGameWorld(
      `runtime-barrels-${stacks}`,
      "survival",
      "pilot",
      73,
    );
    world.upgradeStacks["twin-shot"] = stacks;
    stepGameWorld(world, { ...IDLE_INPUT, fire: true }, 20);
    return world.playerProjectiles.length;
  });
  assert.deepEqual(projectileCounts, [1, 2, 3]);

  const droneCounts = [1, 2].map((stacks) => {
    const world = createGameWorld(
      `runtime-drones-${stacks}`,
      "survival",
      "pilot",
      74,
    );
    world.upgradeStacks["escort-drone"] = stacks;
    stepGameWorld(world, IDLE_INPUT, 20);
    return world.playerProjectiles.filter((shot) => shot.owner === "drone").length;
  });
  assert.deepEqual(droneCounts, [1, 2]);

  const laserWorld = createGameWorld("runtime-cap-laser", "survival", "pilot", 75);
  laserWorld.equippedPowerUp = "laser";
  laserWorld.upgradeStacks["emp-capacitor"] = 3;
  laserWorld.player.energy = 100;
  assert.equal(activateEquippedSuperpower(laserWorld), true);
  assert.equal(
    laserWorld.player.energy,
    100 - POWER_UP_BALANCE.laser.energyCost,
  );

  const empWorld = createGameWorld("runtime-cap-emp", "survival", "pilot", 76);
  empWorld.equippedPowerUp = "emp";
  empWorld.upgradeStacks["emp-capacitor"] = 2;
  empWorld.player.energy = 100;
  assert.equal(activateEquippedSuperpower(empWorld), true);
  assert.equal(empWorld.player.energy, 100 - POWER_UP_BALANCE.emp.energyCost + 16);
  assert.equal(
    empWorld.powerStates.emp?.cooldownUntilMs,
    POWER_UP_BALANCE.emp.cooldownMs - 2_000,
  );
});

test("hull losses remain cumulative across repairs and exact within a sector", () => {
  const world = createGameWorld("runtime-losses-a", "survival", "pilot", 73);

  for (let loss = 0; loss < 4; loss++) {
    world.player.shield = 0;
    world.player.invulnerableUntilMs = 0;
    world.enemyProjectiles.push(
      hostileProjectile(world, { id: `hostile-loss-${loss}` }),
    );
    stepGameWorld(world, IDLE_INPUT, 20);
    if (loss < 3) {
      world.player.lives = Math.min(
        world.player.maxLives,
        world.player.lives + 1,
      );
    }
  }

  assert.equal(world.player.lives, 2);
  assert.equal(world.metrics.livesLost, 4);
  assert.equal(world.metrics.sectors.length, 1);
  assert.equal(world.metrics.sectors[0]?.livesLost, 4);
  assert.equal(
    world.metrics.sectors.reduce(
      (total, sector) => total + sector.livesLost,
      0,
    ),
    world.metrics.livesLost,
  );
});

test("runtime records exact per-wave duration and completion history", () => {
  const world = createGameWorld("runtime-sector-a", "survival", "pilot", 79);
  world.player.invulnerableUntilMs = Number.POSITIVE_INFINITY;
  const firstWaveDurationMs = world.wavePlan.totalDurationMs;

  while (world.status === "playing") {
    const remaining = firstWaveDurationMs - world.activeDurationMs;
    stepGameWorld(world, IDLE_INPUT, Math.min(250, Math.max(1, remaining)));
  }

  assert.equal(world.status, "upgrade");
  assert.deepEqual(world.metrics.sectors, [
    {
      wave: 1,
      sectorId: "starfield",
      durationMs: firstWaveDurationMs,
      completed: true,
      livesLost: 0,
    },
  ]);
  assert.equal(world.metrics.flawlessSectors, 1);

  const selected = world.upgradeChoices[0];
  assert.ok(selected);
  assert.equal(selectUpgrade(world, selected), true);
  assert.deepEqual(world.metrics.sectors[1], {
    wave: 2,
    sectorId: "nebula",
    durationMs: 0,
    completed: false,
    livesLost: 0,
  });
  stepGameWorld(world, IDLE_INPUT, 100);
  assert.equal(world.metrics.sectors[1]?.durationMs, 100);
});

test("wave completion offers a valid upgrade and expedition ends at wave nine", () => {
  const upgradeWorld = createGameWorld("runtime-wave-aa", "survival", "pilot", 27);
  upgradeWorld.waveElapsedMs = upgradeWorld.wavePlan.totalDurationMs - 10;
  const events = stepGameWorld(upgradeWorld, IDLE_INPUT, 20);
  assert.equal(upgradeWorld.status, "upgrade");
  assert.equal(upgradeWorld.upgradeChoices.length, 3);
  assert.ok(events.some((event) => event.type === "upgrade" && event.action === "offered"));

  const selected = upgradeWorld.upgradeChoices[0];
  assert.ok(selected);
  assert.equal(selectUpgrade(upgradeWorld, selected), true);
  assert.equal(upgradeWorld.wave, 2);
  assert.equal(upgradeWorld.status, "playing");
  assert.equal(upgradeWorld.upgradeStacks[selected], 1);

  const expedition = createGameWorld("runtime-win-aaa", "expedition", "pilot", 28);
  while (expedition.wave < 9) assert.equal(advanceWave(expedition), true);
  expedition.waveElapsedMs = expedition.wavePlan.totalDurationMs - 10;
  const victoryEvents = stepGameWorld(expedition, IDLE_INPUT, 20);
  assert.equal(expedition.status, "won");
  assert.equal(expedition.result?.outcome, "victory");
  assert.equal(
    victoryEvents.filter((event) => event.type === "result").length,
    1,
  );
});

test("score remains API-safe, divisible by ten, and hard-capped", () => {
  const world = createGameWorld("runtime-score-a", "survival", "ace", 44);
  for (const value of [1, 7, 11, 49, 103]) {
    awardScore(world, value);
    assert.equal(world.score % 10, 0);
    assert.ok(world.score >= 0 && world.score <= MAX_GAME_SCORE);
  }
  world.score = MAX_GAME_SCORE - 10;
  awardScore(world, MAX_GAME_SCORE);
  assert.equal(world.score, MAX_GAME_SCORE);
  assert.equal(snapshotGameSummary(world).score, MAX_GAME_SCORE);
});

test("terminal result is emitted once and cannot be mutated by later steps", () => {
  const world = createGameWorld("runtime-over-aa", "survival", "pilot", 99);
  world.player.shield = 0;
  world.player.lives = 1;
  world.enemyProjectiles.push(hostileProjectile(world));

  const firstEvents = stepGameWorld(world, IDLE_INPUT, 20);
  const firstSummary = snapshotGameSummary(world);
  assert.equal(world.status, "over");
  assert.equal(firstSummary.outcome, "defeat");
  assert.equal(
    firstEvents.filter((event) => event.type === "result").length,
    1,
  );
  assert.equal(
    firstEvents.some(
      (event) =>
        event.type === "sfx" && (event.id === "OVER" || event.id === "RECORD"),
    ),
    false,
  );

  const secondEvents = stepGameWorld(
    world,
    { ...IDLE_INPUT, fire: true, power: true },
    250,
  );
  assert.deepEqual(secondEvents, []);
  assert.deepEqual(snapshotGameSummary(world), firstSummary);
});
