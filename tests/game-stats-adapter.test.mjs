import assert from "node:assert/strict";
import test from "node:test";

import { gameResultToStatsInput } from "../app/game/statsAdapter.ts";
import { validateRunSummary } from "../shared/gameStats.ts";

test("runtime results map to the validated idempotent v2 statistics contract", () => {
  const input = gameResultToStatsInput(
    {
      runId: "run_0123456789ABCDEFGHJK",
      outcome: "victory",
      mode: "expedition",
      difficulty: "pilot",
      score: 12_340,
      level: 9,
      wave: 9,
      sector: "boss",
      durationMs: 310_000,
      lives: 2,
      controller: "mixed",
      upgrades: { "rapid-fire": 2 },
      equippedPowerUp: "emp",
      metrics: {
        enemiesDestroyed: 88,
        bossesDefeated: 3,
        shotsFired: 140,
        shotsHit: 99,
        longestCombo: 31,
        powerUpsCollected: 12,
        powerUpsUsed: ["emp", "shield", "emp"],
        powerUpsCollectedById: { emp: 3, shield: 2 },
        powerUpsActivatedById: { emp: 4, shield: 1 },
        flawlessSectors: 7,
        livesLost: 2,
        sectors: [
          "starfield",
          "nebula",
          "meteor-belt",
          "ice",
          "ion-storm",
          "ship-graveyard",
          "solar",
          "dark",
          "boss",
        ].map((sectorId, index) => ({
          wave: index + 1,
          sectorId,
          completed: true,
          livesLost: index === 2 || index === 7 ? 1 : 0,
          durationMs: 30_000,
        })),
      },
    },
    "victory",
    new Date("2026-08-01T12:00:00.000Z"),
  );

  assert.equal(validateRunSummary(input).ok, true);
  assert.equal(input.powers.length, 2);
  assert.deepEqual(input.powers, [
    { powerId: "emp", collectedCount: 3, activatedCount: 4 },
    { powerId: "shield", collectedCount: 2, activatedCount: 1 },
  ]);
  assert.equal(input.sectors.length, 9);
  assert.equal(input.sectors.filter((sector) => sector.livesLost === 0).length, 7);
  assert.equal(input.livesLost, 2);
  assert.equal(input.sectors.every((sector) => sector.completed), true);
  assert.equal(input.score % 10, 0);
  assert.equal(input.clientEndedAt, "2026-08-01T12:00:00.000Z");
});

test("adapter preserves repaired hull losses and measured sector facts", () => {
  const input = gameResultToStatsInput(
    {
      runId: "run_0123456789ABCDEFGHJL",
      outcome: "defeat",
      mode: "expedition",
      difficulty: "cadet",
      score: 2_000,
      level: 3,
      wave: 2,
      sector: "nebula",
      durationMs: 50_000,
      lives: 2,
      controller: "arduino",
      upgrades: { "repair-nanites": 1 },
      equippedPowerUp: "repair",
      metrics: {
        enemiesDestroyed: 20,
        bossesDefeated: 0,
        shotsFired: 40,
        shotsHit: 20,
        longestCombo: 8,
        powerUpsCollected: 1,
        powerUpsUsed: ["repair"],
        powerUpsCollectedById: { repair: 1 },
        powerUpsActivatedById: { repair: 3 },
        flawlessSectors: 0,
        livesLost: 4,
        sectors: [
          {
            wave: 1,
            sectorId: "starfield",
            completed: true,
            livesLost: 3,
            durationMs: 30_000,
          },
          {
            wave: 2,
            sectorId: "nebula",
            completed: false,
            livesLost: 1,
            durationMs: 20_000,
          },
        ],
      },
    },
    "defeat",
    new Date("2026-08-01T13:00:00.000Z"),
  );

  assert.equal(validateRunSummary(input).ok, true);
  assert.equal(input.livesLost, 4);
  assert.deepEqual(input.sectors, [
    {
      sectorIndex: 0,
      sectorId: "starfield",
      completed: true,
      livesLost: 3,
      durationMs: 30_000,
    },
    {
      sectorIndex: 1,
      sectorId: "nebula",
      completed: false,
      livesLost: 1,
      durationMs: 20_000,
    },
  ]);
});
