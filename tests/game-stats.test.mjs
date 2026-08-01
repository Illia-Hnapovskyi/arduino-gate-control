import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GAME_ACHIEVEMENTS,
  canonicalJson,
  formatAccessCode,
  generateAccessCode,
  generateRandomNickname,
  generateRunId,
  getGameSectorForWave,
  normalizeAccessCode,
  normalizeNickname,
  validateAccessCode,
  validateLanguage,
  validateGameSyncEvent,
  validateGameSyncEvents,
  validateGameSyncResults,
  validateNickname,
  validatePlayerProgression,
  validateRun,
  validateRunSummary,
} from "../shared/gameStats.ts";

test("access codes are canonical, human-readable, and deterministic with an injected source", () => {
  const code = generateAccessCode((length) =>
    Uint8Array.from({ length }, (_, index) => index),
  );

  assert.equal(code, "01234-56789-ABCDE-FGHJK");
  assert.deepEqual(validateAccessCode(code), {
    ok: true,
    value: "0123456789ABCDEFGHJK",
  });
  assert.equal(formatAccessCode("0123456789abcdefghjk"), code);
  assert.equal(normalizeAccessCode("o1234-i6789-abcde-fghjk"), "0123416789ABCDEFGHJK");
  assert.equal(validateAccessCode("too-short").ok, false);
  assert.equal(validateAccessCode("UUUUU-UUUUU-UUUUU-UUUUU").ok, false);
});

test("access-code and run generators reject malformed random sources", () => {
  assert.throws(
    () => generateAccessCode(() => new Uint8Array(2)),
    /must return 20 bytes/,
  );

  const runId = generateRunId(() => new Uint8Array(20).fill(31));
  assert.equal(runId, "run_ZZZZZZZZZZZZZZZZZZZZ");
  assert.equal(
    validateRun({ runId, score: 0, level: 1, durationMs: 0 }).ok,
    true,
  );
});

test("nicknames normalize whitespace and enforce the public safe allowlist", () => {
  assert.equal(normalizeNickname("  Зоряний\tПілот  "), "Зоряний Пілот");
  assert.deepEqual(validateNickname("Meteör-7"), {
    ok: true,
    value: "Meteör-7",
  });
  assert.equal(validateNickname("a").ok, false);
  assert.equal(validateNickname("123456789012345678901").ok, false);
  assert.equal(validateNickname("<script>").ok, false);
  assert.equal(validateNickname("Pilot🚀").ok, false);
  assert.equal(validateNickname("__").ok, false);
  assert.deepEqual(validateNickname("  ", { allowBlank: true }), {
    ok: true,
    value: "",
  });
});

test("every localized random nickname satisfies the same nickname validator", () => {
  for (const language of ["uk", "de", "en"]) {
    for (const randomValue of [0, 0.1, 0.5, 0.999999]) {
      const nickname = generateRandomNickname(language, randomValue);
      const validation = validateNickname(nickname);
      assert.equal(validation.ok, true, `${language}: ${nickname}`);
      assert.match(nickname, /\d{6}$/);
    }
  }

  const sample = new Set(
    Array.from({ length: 1_000 }, (_, index) =>
      generateRandomNickname("en", index / 1_000),
    ),
  );
  assert.equal(sample.size, 1_000);
});

test("language and completed-run validation reject forged or implausible values", () => {
  assert.deepEqual(validateLanguage("uk"), { ok: true, value: "uk" });
  assert.equal(validateLanguage("fr").ok, false);

  const valid = {
    runId: "run_0123456789ABCDEFGHJK",
    score: 7_000,
    level: 9,
    durationMs: 180_000,
  };
  assert.deepEqual(validateRun(valid), { ok: true, value: valid });
  assert.equal(
    validateRun({ ...valid, score: 30, level: 1, durationMs: 220 }).ok,
    true,
  );

  for (const invalid of [
    { ...valid, runId: "bad id" },
    { ...valid, score: -1 },
    { ...valid, score: Number.NaN },
    { ...valid, score: 100_000_001 },
    { ...valid, score: 7_001 },
    { ...valid, level: 10 },
    { ...valid, level: 9, durationMs: 21_999 },
    { ...valid, durationMs: 21_600_001 },
    { ...valid, durationMs: 1.5 },
  ]) {
    assert.equal(validateRun(invalid).ok, false);
  }
});

test("v2 run summaries normalize progression facts without weakening legacy rules", () => {
  const summary = {
    runId: "run_0123456789ABCDEFGHJK",
    score: 12_000,
    level: 9,
    durationMs: 180_000,
    modeId: "expedition",
    difficultyId: "ace",
    highestWave: 9,
    finalSectorId: "boss",
    enemiesDestroyed: 91,
    bossesDefeated: 3,
    shotsFired: 100,
    shotsHit: 72,
    longestCombo: 31,
    powerupsCollected: 8,
    livesLost: 2,
    won: true,
    inputKind: "arduino",
    endedReason: "victory",
    powers: [
      { powerId: "laser", collectedCount: 2, activatedCount: 4 },
      { powerId: "shield", collectedCount: 1, activatedCount: 1 },
    ],
    sectors: [
      {
        sectorIndex: 0,
        sectorId: "starfield",
        completed: true,
        livesLost: 0,
        durationMs: 20_000,
      },
    ],
  };
  const validated = validateRunSummary(summary);
  assert.equal(validated.ok, true);
  assert.deepEqual(
    validated.ok ? validated.value.powers.map((power) => power.powerId) : [],
    ["laser", "shield"],
  );

  assert.equal(validateRunSummary({ ...summary, score: 12_001 }).ok, false);
  assert.equal(validateRunSummary({ ...summary, shotsHit: 101 }).ok, false);
  assert.equal(validateRunSummary({ ...summary, modeId: "forged" }).ok, false);
  assert.equal(
    validateRunSummary({
      ...summary,
      powers: [...summary.powers, summary.powers[0]],
    }).ok,
    false,
  );

  for (const forged of [
    { ...summary, durationMs: 21_999, level: 1, highestWave: 2 },
    { ...summary, highestWave: 8, finalSectorId: "boss", won: false, endedReason: "defeat" },
    { ...summary, bossesDefeated: 4 },
    { ...summary, enemiesDestroyed: 1_801 },
    { ...summary, enemiesDestroyed: 10, longestCombo: 11 },
    { ...summary, enemiesDestroyed: 6, bossesDefeated: 0, powerupsCollected: 7 },
    { ...summary, livesLost: 27 },
    {
      ...summary,
      powers: [{ powerId: "laser", collectedCount: 9, activatedCount: 1 }],
    },
    {
      ...summary,
      powers: [{ powerId: "laser", collectedCount: 1, activatedCount: 182 }],
    },
    {
      ...summary,
      durationMs: 39_999,
      level: 2,
      highestWave: 2,
      finalSectorId: "nebula",
      won: false,
      endedReason: "defeat",
      sectors: [
        { sectorIndex: 0, sectorId: "starfield", completed: true, livesLost: 0, durationMs: 20_000 },
        { sectorIndex: 1, sectorId: "nebula", completed: true, livesLost: 0, durationMs: 19_999 },
      ],
    },
    {
      ...summary,
      sectors: [{ sectorIndex: 0, sectorId: "starfield", completed: true, livesLost: 0, durationMs: 180_001 }],
    },
    { ...summary, modeId: "survival", won: true, endedReason: "victory" },
    { ...summary, won: false, endedReason: "victory" },
    { ...summary, won: true, endedReason: "defeat" },
  ]) {
    assert.equal(validateRunSummary(forged).ok, false, JSON.stringify(forged));
  }
});

test("shared sector mapping matches the nine-sector modes and classic contract", () => {
  const expected = [
    "starfield",
    "nebula",
    "meteor-belt",
    "ice",
    "ion-storm",
    "ship-graveyard",
    "solar",
    "dark",
    "boss",
  ];
  assert.deepEqual(
    Array.from({ length: 18 }, (_, index) =>
      getGameSectorForWave("expedition", index + 1),
    ),
    [...expected, ...expected],
  );
  assert.equal(getGameSectorForWave("classic", 10_000), "starfield");
  assert.throws(() => getGameSectorForWave("survival", 0), /positive/);
});

test("sync events are bounded, canonical, and bind event IDs to run IDs", () => {
  const event = {
    eventId: "run_0123456789ABCDEFGHJK",
    kind: "run.completed",
    version: 2,
    payload: {
      runId: "run_0123456789ABCDEFGHJK",
      score: 100,
      level: 1,
      durationMs: 2_000,
    },
  };
  assert.equal(validateGameSyncEvent(event).ok, true);
  assert.equal(
    validateGameSyncEvent({ ...event, eventId: "run_DIFFERENT1234" }).ok,
    false,
  );
  assert.equal(validateGameSyncEvents(Array(5).fill(event)).ok, false);
  assert.equal(
    validateGameSyncEvents(
      Array.from({ length: 5 }, (_, index) => ({
        ...event,
        eventId: `run_0123456789ABCDE${index}`,
        payload: {
          ...event.payload,
          runId: `run_0123456789ABCDE${index}`,
        },
      })),
    ).ok,
    true,
  );
  assert.equal(
    validateGameSyncEvents(
      Array.from({ length: 6 }, (_, index) => ({
        ...event,
        eventId: `run_0123456789ABCDE${index}`,
        payload: {
          ...event.payload,
          runId: `run_0123456789ABCDE${index}`,
        },
      })),
    ).ok,
    false,
  );
  assert.equal(
    canonicalJson({ z: 1, a: { d: 2, b: 3 } }),
    canonicalJson({ a: { b: 3, d: 2 }, z: 1 }),
  );
});

test("progression and sync-response parsers reject malformed nested data", () => {
  const progression = {
    schemaVersion: 2,
    serverRevision: 4,
    totals: {
      enemiesDestroyed: 15,
      bossesDefeated: 1,
      shotsFired: 40,
      shotsHit: 28,
      longestCombo: 8,
      powerupsCollected: 3,
      longestRunMs: 80_000,
      wins: 0,
      arduinoRuns: 1,
      bestAccuracyPermille: 700,
    },
    modes: [{
      modeId: "expedition",
      difficultyId: "pilot",
      gamesPlayed: 1,
      totalScore: 1_000,
      highScore: 1_000,
      highestWave: 3,
      enemiesDestroyed: 15,
      bossesDefeated: 1,
      totalDurationMs: 80_000,
      wins: 0,
    }],
    powers: [{ powerId: "shield", collectedCount: 1, activatedCount: 2 }],
    achievements: [{
      achievementId: "first_run",
      progress: 1,
      unlockedAt: "2026-08-01T00:00:00.000Z",
    }],
    unlocks: [{
      unlockId: "achievement:first_run",
      unlockedAt: "2026-08-01T00:00:00.000Z",
    }],
    settings: {
      revision: 2,
      musicVolume: 42,
      effectsVolume: 28,
      screenShake: true,
      reducedMotion: false,
    },
  };
  assert.equal(validatePlayerProgression(progression).ok, true);
  assert.equal(
    validatePlayerProgression({
      ...progression,
      totals: { ...progression.totals, shotsHit: 41 },
    }).ok,
    false,
  );
  assert.equal(
    validatePlayerProgression({
      ...progression,
      powers: [...progression.powers, progression.powers[0]],
    }).ok,
    false,
  );
  assert.equal(
    validatePlayerProgression({
      ...progression,
      achievements: [{
        achievementId: "first_run",
        progress: 0,
        unlockedAt: "2026-08-01T00:00:00.000Z",
      }],
    }).ok,
    false,
  );

  const results = [{
    eventId: "run_0123456789ABCDEFGHJK",
    status: "applied",
    unlockedAchievementIds: ["first_run"],
  }];
  assert.equal(validateGameSyncResults(results).ok, true);
  assert.equal(
    validateGameSyncResults([...results, results[0]]).ok,
    false,
  );
  assert.equal(
    validateGameSyncResults([{ ...results[0], status: "forged" }]).ok,
    false,
  );
});

test("achievement catalog has stable unique IDs including accuracy progression", () => {
  assert.equal(
    new Set(GAME_ACHIEVEMENTS.map((achievement) => achievement.id)).size,
    GAME_ACHIEVEMENTS.length,
  );
  assert.deepEqual(
    GAME_ACHIEVEMENTS.find((achievement) => achievement.id === "sharpshooter"),
    { id: "sharpshooter", target: 700, rarity: "rare", icon: "crosshair" },
  );
});

test("progression migration keeps permanent dedupe and deny-by-default RLS", async () => {
  const migration = await readFile(
    new URL("../db/migrations/0002_game_progression.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /UNIQUE \(player_id, event_id\)/);
  assert.match(migration, /payload_sha256 CHAR\(64\) NOT NULL/);
  assert.match(migration, /shots_hit BETWEEN 0 AND shots_fired/);
  assert.match(migration, /highest_wave BETWEEN 1 AND LEAST/);
  assert.match(migration, /enemies_destroyed BETWEEN 0 AND duration_ms \/ 100/);
  assert.match(
    migration,
    /lives_lost BETWEEN 0 AND\s+3 \+ powerups_collected \+ highest_wave \+ duration_ms \/ 30000/,
  );
  assert.match(migration, /ended_reason = 'victory'/);
  assert.match(migration, /best_accuracy_permille BETWEEN 0 AND 1000/);
  assert.match(migration, /INSERT INTO game_player_achievements/);
  assert.match(migration, /game_sync_events ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FROM anon, authenticated, service_role/);
  assert.doesNotMatch(migration, /CREATE POLICY/i);
});
