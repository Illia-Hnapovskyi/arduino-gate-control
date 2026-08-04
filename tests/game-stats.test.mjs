import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GAME_ACHIEVEMENTS,
  GAME_STATS_ACTIONS,
  canonicalJson,
  evaluateCredentialMatrix,
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
  validateProfilePublicId,
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

  // An omitted final sector must resolve to the same value the SQL CHECK derives
  // from mode+wave. A fixed fallback previously let the API accept a payload that
  // Postgres rejected with SQLSTATE 23514, which surfaced as a bogus outage.
  const withoutSector = {
    ...summary,
    modeId: "survival",
    difficultyId: "pilot",
    durationMs: 44_000,
    level: 2,
    highestWave: 2,
    bossesDefeated: 0,
    won: false,
    endedReason: "defeat",
  };
  delete withoutSector.finalSectorId;
  const derivedSector = validateRunSummary(withoutSector);
  assert.equal(derivedSector.ok, true);
  assert.equal(
    derivedSector.ok ? derivedSector.value.finalSectorId : null,
    "nebula",
  );
  assert.equal(
    validateRunSummary({ ...withoutSector, finalSectorId: "starfield" }).ok,
    false,
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

test("profile public IDs normalize case and whitespace but reject non-UUIDs", () => {
  const canonical = "3f1a2b4c-5d6e-4f70-8912-a3b4c5d6e7f8";
  assert.deepEqual(validateProfilePublicId(canonical), {
    ok: true,
    value: canonical,
  });
  // Uppercase input is normalized to lowercase, surrounding whitespace trimmed.
  assert.deepEqual(validateProfilePublicId(canonical.toUpperCase()), {
    ok: true,
    value: canonical,
  });
  assert.deepEqual(
    validateProfilePublicId(`  \t${canonical.toUpperCase()}\n `),
    { ok: true, value: canonical },
  );

  for (const invalid of [
    "",
    "   ",
    "not-a-uuid",
    // Missing one hex digit in the last group.
    "3f1a2b4c-5d6e-4f70-8912-a3b4c5d6e7f",
    // One digit too many.
    `${canonical}9`,
    // Braced and unhyphenated forms are not accepted.
    `{${canonical}}`,
    canonical.replaceAll("-", ""),
    // Non-hex character inside an otherwise well-shaped UUID.
    "3f1a2b4c-5d6e-4f70-8912-a3b4c5d6e7fz",
    // Interior whitespace survives the trim and must fail.
    "3f1a2b4c-5d6e-4f70-8912-a3b4c5 d6e7f8",
  ]) {
    const result = validateProfilePublicId(invalid);
    assert.equal(result.ok, false, JSON.stringify(invalid));
    assert.match(result.error, /Profile public ID/);
  }

  for (const nonString of [
    undefined,
    null,
    12,
    true,
    ["3f1a2b4c-5d6e-4f70-8912-a3b4c5d6e7f8"],
    { value: "3f1a2b4c-5d6e-4f70-8912-a3b4c5d6e7f8" },
  ]) {
    assert.deepEqual(validateProfilePublicId(nonString), {
      ok: false,
      error: "Profile public ID must be text.",
    });
  }
});

test("the credential matrix decides every action against every credential pair", () => {
  const ok = (credential) => ({ ok: true, credential });
  const mixed = { ok: false, status: 400, code: "MIXED_CREDENTIALS" };
  const codeMissing = { ok: false, status: 400, code: "INVALID_ACCESS_CODE" };
  const bearerMissing = { ok: false, status: 401, code: "AUTH_TOKEN_MISSING" };

  // Cells: [code only, bearer only, both, neither]. link/unlink are the only
  // both-actions, so a lone credential is reported as the missing counterpart:
  // a code alone is a missing token (401), a bearer alone a missing code (400).
  const singleCredentialAction = {
    code: ok("code"),
    bearer: ok("bearer"),
    both: mixed,
    neither: codeMissing,
  };
  const expected = {
    create: singleCredentialAction,
    // connect stays code-only: bearer users call session instead.
    connect: { code: ok("code"), bearer: mixed, both: mixed, neither: codeMissing },
    rename: singleCredentialAction,
    record: singleCredentialAction,
    sync: singleCredentialAction,
    link: {
      code: bearerMissing,
      bearer: codeMissing,
      both: ok("both"),
      neither: bearerMissing,
    },
    unlink: {
      code: bearerMissing,
      bearer: codeMissing,
      both: ok("both"),
      neither: bearerMissing,
    },
    // session is bearer-only: any access code is mixed credentials.
    session: {
      code: mixed,
      bearer: ok("bearer"),
      both: mixed,
      neither: bearerMissing,
    },
  };

  const combinations = {
    code: [true, false],
    bearer: [false, true],
    both: [true, true],
    neither: [false, false],
  };

  // Every action in the shared list must be covered by the table above.
  assert.deepEqual(
    Object.keys(expected).sort(),
    [...GAME_STATS_ACTIONS].sort(),
  );

  for (const action of GAME_STATS_ACTIONS) {
    for (const [name, [hasAccessCode, hasBearerToken]] of Object.entries(
      combinations,
    )) {
      const decision = evaluateCredentialMatrix(
        action,
        hasAccessCode,
        hasBearerToken,
      );
      const cell = expected[action][name];
      const label = `${action} / ${name}`;
      assert.equal(decision.ok, cell.ok, label);
      if (cell.ok) {
        assert.equal(decision.credential, cell.credential, label);
      } else {
        assert.equal(decision.status, cell.status, label);
        assert.equal(decision.code, cell.code, label);
        assert.equal(typeof decision.error, "string", label);
      }
    }
  }
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

test("account-link migration keeps the 1:1 mapping private and deny-by-default", async () => {
  const migration = await readFile(
    new URL("../db/migrations/0004_account_links.sql", import.meta.url),
    "utf8",
  );

  // Cardinality: PRIMARY KEY (player_id) = one profile → max one account;
  // UNIQUE (auth_user_id) = one account → max one profile. Both FKs cascade so
  // deleting the auth user removes only the mapping row, never the profile.
  assert.match(
    migration,
    /player_id BIGINT PRIMARY KEY\s+REFERENCES game_players\(id\) ON DELETE CASCADE/,
  );
  assert.match(
    migration,
    /auth_user_id UUID NOT NULL UNIQUE\s+REFERENCES auth\.users\(id\) ON DELETE CASCADE/,
  );

  // public_id uses the two-step add + backfill pattern: the NOT NULL guarantee
  // arrives as a CHECK added NOT VALID and then validated, never a blocking
  // ALTER COLUMN ... SET NOT NULL rewrite.
  assert.match(migration, /CHECK \(public_id IS NOT NULL\) NOT VALID/);
  assert.match(
    migration,
    /VALIDATE CONSTRAINT game_players_public_id_not_null/,
  );

  // The rate-limit bucket allowlist must contain exactly the seven live
  // buckets; a missing one turns that limiter's inserts into bogus 503s.
  const bucketCheck = migration.match(/bucket IN \(([^)]*)\)/);
  assert.ok(bucketCheck, "bucket allowlist CHECK missing");
  const buckets = [...bucketCheck[1].matchAll(/'([a-z_]+)'/g)].map(
    (entry) => entry[1],
  );
  assert.deepEqual(
    [...buckets].sort(),
    [
      "account_link",
      "ip_create",
      "ip_link",
      "ip_write",
      "profile_record",
      "profile_rename",
      "profile_sync",
    ],
  );

  // Deny-by-default: RLS on with zero policies plus explicit revokes, and
  // never FORCE ROW LEVEL SECURITY — the owner relies on the owner bypass.
  // Absence checks run on comment-stripped SQL: the migration's own comments
  // legitimately warn about FORCE ROW LEVEL SECURITY.
  assert.match(migration, /game_account_links ENABLE ROW LEVEL SECURITY/);
  assert.match(
    migration,
    /REVOKE ALL ON TABLE game_account_links\s+FROM anon, authenticated, service_role/,
  );
  const statementsOnly = migration.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(statementsOnly, /CREATE POLICY/i);
  assert.doesNotMatch(statementsOnly, /FORCE ROW LEVEL SECURITY/i);
});

test("base table migration closes the Data API grant gap left by 0001", async () => {
  const migration = await readFile(
    new URL("../db/migrations/0003_base_table_grants.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /REVOKE ALL ON TABLE/);
  for (const table of ["game_players", "game_runs", "game_rate_limits"]) {
    assert.match(migration, new RegExp(`\\b${table}\\b`));
  }
  assert.match(migration, /REVOKE ALL ON SEQUENCE/);
  // Assert the exact BIGSERIAL sequence names 0001 creates: a typo here would
  // pass a substring check and only fail inside Supabase.
  for (const sequence of ["game_players_id_seq", "game_runs_id_seq"]) {
    assert.match(migration, new RegExp(`\\b${sequence}\\b`));
  }
  assert.match(migration, /FROM anon, authenticated, service_role/);
  // Privileges only: this migration must never create objects or open access.
  assert.doesNotMatch(migration, /CREATE POLICY/i);
  assert.doesNotMatch(migration, /^\s*GRANT\b/mi);
  assert.doesNotMatch(migration, /CREATE TABLE|ALTER TABLE|DROP TABLE/i);
});
