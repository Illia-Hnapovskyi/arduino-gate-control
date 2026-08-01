import assert from "node:assert/strict";
import test from "node:test";

import {
  ACHIEVEMENT_IDS,
  EMPTY_ACHIEVEMENT_STATS,
  accumulateAchievementStats,
  evaluateAchievements,
  previewAchievementStats,
} from "../app/game/achievements.ts";
import {
  ENEMY_BALANCE,
  MAX_PLANNABLE_WAVES,
  MAX_RUN_DURATION_MS,
  MODE_BALANCE,
  POWER_UP_BALANCE,
  SECTOR_BALANCE,
  UPGRADE_BALANCE,
} from "../app/game/balance.ts";
import {
  RUN_SNAPSHOT_STORAGE_KEY,
  RUN_SNAPSHOT_VERSION,
  canResumeRun,
  clearRunSnapshot,
  getRemainingRunDurationMs,
  loadRunSnapshot,
  parseRunSnapshot,
  saveRunSnapshot,
  sanitizeRunSnapshot,
  serializeRunSnapshot,
} from "../app/game/persistence.ts";
import {
  activatePowerUp,
  addUpgradeStack,
  getPowerUpCooldownRemaining,
  isPowerUpActive,
  selectUpgradeChoices,
} from "../app/game/powerUps.ts";
import {
  combineSeed,
  createSeededRng,
  nextSeededValue,
} from "../app/game/rng.ts";
import {
  DIFFICULTY_IDS,
  ENEMY_ARCHETYPE_IDS,
  GAME_MODE_IDS,
  POWER_UP_IDS,
  SECTOR_IDS,
} from "../app/game/types.ts";
import {
  createWavePlan,
  getBossIdForWave,
  getSectorIdForWave,
  isBossWave,
  isFinalModeWave,
} from "../app/game/waves.ts";

test("game balance exposes three modes, three difficulties, nine sectors, and ten enemies", () => {
  assert.deepEqual(GAME_MODE_IDS, ["expedition", "survival", "classic"]);
  assert.deepEqual(DIFFICULTY_IDS, ["cadet", "pilot", "ace"]);
  assert.equal(SECTOR_IDS.length, 9);
  assert.equal(ENEMY_ARCHETYPE_IDS.length, 10);
  assert.deepEqual(POWER_UP_IDS, [
    "shield",
    "spread",
    "laser",
    "missiles",
    "emp",
    "time",
    "magnet",
    "drone",
    "repair",
    "pulse",
    "invulnerability",
    "critical",
    "speed",
    "charge",
  ]);
  assert.deepEqual(
    Object.keys(POWER_UP_BALANCE).sort(),
    [...POWER_UP_IDS].sort(),
  );
  assert.deepEqual(Object.keys(SECTOR_BALANCE).sort(), [...SECTOR_IDS].sort());
  assert.deepEqual(
    Object.keys(ENEMY_BALANCE).sort(),
    [...ENEMY_ARCHETYPE_IDS].sort(),
  );
  for (const enemy of Object.values(ENEMY_BALANCE)) {
    assert.equal(enemy.score % 10, 0);
  }
});

test("expedition progresses through all sectors and telegraph/combat/rest phases", () => {
  const sectors = Array.from({ length: 9 }, (_, index) =>
    getSectorIdForWave("expedition", index + 1),
  );
  assert.deepEqual(sectors, SECTOR_IDS);

  const plan = createWavePlan({
    mode: "expedition",
    difficulty: "pilot",
    wave: 2,
    seed: "campaign-alpha",
  });
  assert.deepEqual(
    plan.phases.map((phase) => phase.kind),
    ["telegraph", "combat", "rest"],
  );
  assert.equal(plan.phases[1].durationMs, 22_000);
  assert.equal(plan.totalDurationMs, 30_500);
  assert.equal(plan.boss, null);
  assert.equal(isFinalModeWave("expedition", 9), true);
  assert.throws(
    () =>
      createWavePlan({
        mode: "expedition",
        difficulty: "pilot",
        wave: 10,
        seed: 1,
      }),
    /ends after wave 9/,
  );
});

test("boss waves use distinct phased bosses without becoming oversized regular enemies", () => {
  assert.deepEqual(
    [3, 6, 9].map((wave) => getBossIdForWave("expedition", wave)),
    ["sentinel-array", "comet-leviathan", "void-dreadnought"],
  );
  assert.equal(isBossWave("expedition", 2), false);
  assert.equal(isBossWave("classic", 3), false);

  const plan = createWavePlan({
    mode: "expedition",
    difficulty: "ace",
    wave: 6,
    seed: 42,
  });
  assert.equal(plan.boss?.boss, "comet-leviathan");
  assert.ok((plan.boss?.telegraphAtMs ?? Infinity) < (plan.boss?.spawnAtMs ?? 0));
  assert.equal(plan.phases[2].durationMs, MODE_BALANCE.expedition.restDurationMs + 2_000);
});

test("classic mode keeps its asteroid-only threat contract", () => {
  const classicThreats = new Set([
    "swift-asteroid",
    "splitter-asteroid",
    "armored-asteroid",
    "comet",
    "debris",
  ]);
  for (let wave = 1; wave <= 20; wave++) {
    const plan = createWavePlan({
      mode: "classic",
      difficulty: "ace",
      wave,
      seed: `classic-contract-${wave}`,
    });
    assert.ok(plan.spawns.length > 0);
    assert.ok(
      plan.spawns.every((spawn) => classicThreats.has(spawn.archetype)),
    );
    assert.equal(plan.boss, null);
  }
});

test("seeded RNG and wave spawns are deterministic and replayable", () => {
  const firstRng = createSeededRng("same-seed");
  const secondRng = createSeededRng("same-seed");
  assert.deepEqual(
    Array.from({ length: 8 }, () => firstRng.next()),
    Array.from({ length: 8 }, () => secondRng.next()),
  );
  assert.deepEqual(nextSeededValue(123), nextSeededValue(123));
  assert.equal(combineSeed("run", 4), combineSeed("run", 4));

  const options = {
    mode: "survival",
    difficulty: "pilot",
    wave: 7,
    seed: "replay-me",
  };
  const firstPlan = createWavePlan(options);
  const secondPlan = createWavePlan(options);
  const otherPlan = createWavePlan({ ...options, seed: "different" });
  assert.deepEqual(firstPlan, secondPlan);
  assert.notDeepEqual(firstPlan.spawns, otherPlan.spawns);
  assert.ok(firstPlan.spawns.length > 0);
  assert.ok(
    firstPlan.spawns.every(
      (spawn) => ENEMY_BALANCE[spawn.archetype].unlockWave <= options.wave,
    ),
  );
});

test("the wave planner cannot schedule more than six hours of combat", () => {
  assert.equal(MAX_RUN_DURATION_MS, 21_600_000);
  assert.equal(MAX_PLANNABLE_WAVES, 981);
  assert.doesNotThrow(() =>
    createWavePlan({
      mode: "survival",
      difficulty: "pilot",
      wave: MAX_PLANNABLE_WAVES,
      seed: 7,
    }),
  );
  assert.throws(
    () =>
      createWavePlan({
        mode: "survival",
        difficulty: "pilot",
        wave: MAX_PLANNABLE_WAVES + 1,
        seed: 7,
      }),
    /between 1 and 981/,
  );
});

test("upgrade offers are balanced, deterministic, unique, and respect stack caps", () => {
  const options = {
    seed: "upgrade-seed",
    wave: 4,
    mode: "expedition",
  };
  const first = selectUpgradeChoices(options);
  const second = selectUpgradeChoices(options);
  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
  assert.equal(new Set(first).size, 3);
  assert.deepEqual(
    new Set(first.map((id) => UPGRADE_BALANCE[id].category)),
    new Set(["weapon", "defense", "utility"]),
  );

  const owned = {
    "twin-shot": UPGRADE_BALANCE["twin-shot"].maxStacks,
  };
  assert.equal(
    selectUpgradeChoices({ ...options, owned }).includes("twin-shot"),
    false,
  );
  assert.deepEqual(
    addUpgradeStack(owned, "twin-shot"),
    owned,
    "a capped upgrade must not grow",
  );
  assert.deepEqual(
    selectUpgradeChoices({ ...options, mode: "classic" }),
    [],
  );
});

test("power-up duration and cooldown gates are deterministic", () => {
  const activated = activatePowerUp("emp", 1_000, 100);
  assert.ok(activated);
  assert.equal(
    activated.activeUntilMs,
    1_000 + POWER_UP_BALANCE.emp.durationMs,
  );
  assert.equal(
    activated.cooldownUntilMs,
    1_000 + POWER_UP_BALANCE.emp.cooldownMs,
  );
  assert.equal(isPowerUpActive(activated, 1_100), true);
  assert.equal(isPowerUpActive(activated, activated.activeUntilMs), false);
  assert.equal(activatePowerUp("emp", 5_000, 100, activated), null);
  assert.equal(activatePowerUp("emp", activated.cooldownUntilMs, 59, activated), null);
  assert.ok(activatePowerUp("emp", activated.cooldownUntilMs, 60, activated));
  assert.equal(getPowerUpCooldownRemaining(activated, 4_000), 15_000);
});

test("achievement progress is monotonic and unlock timestamps remain stable", () => {
  assert.deepEqual(ACHIEVEMENT_IDS, [
    "first_run",
    "first_enemy",
    "first_boss",
    "survivor_5m",
    "flawless_sector",
    "combo_25",
    "score_10000",
    "arduino_pilot",
    "power_explorer",
    "max_level",
    "veteran_10",
    "sharpshooter",
  ]);
  const stats = accumulateAchievementStats(EMPTY_ACHIEVEMENT_STATS, {
    durationMs: 305_000,
    score: 12_000,
    threatLevel: 9,
    controller: "arduino",
    metrics: {
      enemiesDestroyed: 24,
      bossesDefeated: 1,
      shotsFired: 20,
      shotsHit: 16,
      longestCombo: 25,
      powerUpsCollected: 5,
      powerUpsUsed: POWER_UP_IDS,
      flawlessSectors: 1,
    },
  });
  const first = evaluateAchievements(stats, {}, 10_000);
  assert.deepEqual(
    first.newlyUnlocked.sort(),
    ACHIEVEMENT_IDS.filter((id) => id !== "veteran_10").sort(),
  );
  assert.equal(first.progress.veteran_10.progress, 1);
  assert.equal(stats.bestAccuracyPermille, 800);
  assert.equal(first.progress.sharpshooter.progress, 700);
  assert.equal(first.progress.first_boss.unlockedAtMs, 10_000);

  const second = evaluateAchievements(
    EMPTY_ACHIEVEMENT_STATS,
    first.progress,
    20_000,
  );
  assert.deepEqual(second.newlyUnlocked, []);
  assert.equal(second.progress.first_boss.progress, 1);
  assert.equal(second.progress.first_boss.unlockedAtMs, 10_000);
});

test("live achievement previews do not count an unfinished run", () => {
  const run = {
    durationMs: 305_000,
    score: 12_000,
    threatLevel: 9,
    controller: "arduino",
    metrics: {
      enemiesDestroyed: 24,
      bossesDefeated: 1,
      shotsFired: 20,
      shotsHit: 16,
      longestCombo: 25,
      powerUpsCollected: 5,
      powerUpsUsed: POWER_UP_IDS,
      flawlessSectors: 1,
    },
  };
  const preview = previewAchievementStats(EMPTY_ACHIEVEMENT_STATS, run);
  const live = evaluateAchievements(preview, {}, 10_000);
  assert.equal(live.progress.first_enemy.unlockedAtMs, 10_000);
  assert.equal(live.progress.first_run.unlockedAtMs, null);
  assert.equal(live.progress.arduino_pilot.unlockedAtMs, null);

  const completed = accumulateAchievementStats(EMPTY_ACHIEVEMENT_STATS, run);
  const final = evaluateAchievements(completed, {}, 11_000);
  assert.equal(final.progress.first_run.unlockedAtMs, 11_000);
  assert.equal(final.progress.arduino_pilot.unlockedAtMs, 11_000);

  const boundary = accumulateAchievementStats(EMPTY_ACHIEVEMENT_STATS, {
    ...run,
    metrics: {
      ...run.metrics,
      shotsFired: 10_000,
      shotsHit: 6_995,
    },
  });
  assert.equal(boundary.bestAccuracyPermille, 699);
  assert.equal(
    evaluateAchievements(boundary, {}, 12_000).progress.sharpshooter.unlockedAtMs,
    null,
  );
});

function validSnapshot(overrides = {}) {
  return {
    version: RUN_SNAPSHOT_VERSION,
    createdAtMs: 1_000,
    savedAtMs: 2_000,
    run: {
      runId: "run_0123456789ABCDEFGHJK",
      mode: "expedition",
      difficulty: "pilot",
      seed: 12345,
      wave: 2,
      sector: "nebula",
      phase: "upgrade",
      activeDurationMs: 22_000,
      score: 1_200,
      lives: 2,
      controller: "keyboard",
      upgradeStacks: { "rapid-fire": 1 },
      equippedPowerUp: "emp",
      powerCooldownRemainingMs: { emp: 3_000 },
      metrics: {
        enemiesDestroyed: 12,
        bossesDefeated: 0,
        shotsFired: 40,
        shotsHit: 25,
        longestCombo: 6,
        powerUpsCollected: 2,
        powerUpsUsed: ["shield"],
        flawlessSectors: 0,
      },
      ...overrides,
    },
  };
}

test("resumable snapshots round-trip, sanitize derived data, and expire", () => {
  const source = validSnapshot({ sector: "wrong-sector" });
  const serialized = serializeRunSnapshot(source);
  const parsed = parseRunSnapshot(serialized, 3_000);
  assert.ok(parsed);
  assert.equal(parsed.profileOwnerId, null);
  assert.equal(parsed.run.sector, "nebula");
  assert.equal(canResumeRun(parsed), true);
  assert.equal(
    getRemainingRunDurationMs(parsed),
    MAX_RUN_DURATION_MS - 22_000,
  );
  assert.equal(parseRunSnapshot(serialized, 10 * 24 * 60 * 60 * 1000), null);

  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  assert.equal(saveRunSnapshot(storage, parsed), true);
  assert.equal(values.has(RUN_SNAPSHOT_STORAGE_KEY), true);
  assert.deepEqual(loadRunSnapshot(storage, 3_000), parsed);
  assert.equal(clearRunSnapshot(storage), true);
  assert.equal(loadRunSnapshot(storage, 3_000), null);
});

test("snapshot owner binding is validated and storage failures are fail-soft", () => {
  const bound = sanitizeRunSnapshot({
    ...validSnapshot(),
    profileOwnerId: "profile_0123456789abcdef",
  });
  assert.equal(bound?.profileOwnerId, "profile_0123456789abcdef");
  assert.equal(
    sanitizeRunSnapshot({
      ...validSnapshot(),
      profileOwnerId: "profile_not-safe",
    }),
    null,
  );

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
  assert.equal(saveRunSnapshot(failingStorage, bound), false);
  assert.equal(loadRunSnapshot(failingStorage, 3_000), null);
  assert.equal(clearRunSnapshot(failingStorage), false);
});

test("snapshot validation rejects forged scores and runs beyond the six-hour cap", () => {
  assert.equal(sanitizeRunSnapshot(validSnapshot({ score: 1_201 })), null);
  assert.equal(
    sanitizeRunSnapshot(
      validSnapshot({ activeDurationMs: MAX_RUN_DURATION_MS + 1 }),
    ),
    null,
  );
  const capped = sanitizeRunSnapshot(
    validSnapshot({ activeDurationMs: MAX_RUN_DURATION_MS }),
  );
  assert.ok(capped);
  assert.equal(canResumeRun(capped), false);
});

test("legacy version-one checkpoints migrate without losing capped upgrades", () => {
  const legacy = {
    version: 1,
    createdAtMs: 1_000,
    savedAtMs: 2_000,
    runId: "run_0123456789ABCDEFGHJK",
    mode: "expedition",
    difficulty: "cadet",
    seed: 99,
    currentWave: 3,
    durationMs: 44_000,
    score: 900,
    lives: 3,
    controller: "touch",
    upgrades: ["rapid-fire", "rapid-fire", "rapid-fire", "rapid-fire"],
    equippedPowerUp: "triple-shot",
    metrics: {
      enemiesDestroyed: 9,
      powerUpsUsed: ["time-slow", "escort-drone", "repulsor-wave"],
    },
  };
  const migrated = sanitizeRunSnapshot(legacy);
  assert.ok(migrated);
  assert.equal(migrated.version, 2);
  assert.equal(
    migrated.run.upgradeStacks["rapid-fire"],
    UPGRADE_BALANCE["rapid-fire"].maxStacks,
  );
  assert.equal(migrated.run.sector, "meteor-belt");
  assert.equal(migrated.run.equippedPowerUp, "spread");
  assert.deepEqual(migrated.run.metrics.powerUpsUsed, ["drone", "pulse", "time"]);
  assert.equal(migrated.run.metrics.enemiesDestroyed, 9);
});
