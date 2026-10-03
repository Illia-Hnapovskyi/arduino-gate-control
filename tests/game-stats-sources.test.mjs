import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  GAME_STATISTICS_SOURCES,
  canonicalJson,
  emptySourceProgression,
  playerStatsSources,
  playerStatsForSource,
  playerProgressionForSource,
  validateGameSyncEvent,
  validatePlayerProgression,
  validateRunSummary,
} from "../shared/gameStats.ts";
import { addRunToStats, addRunToProgression, postSync, sanitizeStoredGameStatsV3, mergeStoredGameStatsV3 } from "../app/useGameStats.ts";

const timestamp = "2026-09-24T10:00:00.000Z";
const profile = { nickname: "Test Pilot", gamesPlayed: 3, totalScore: 600, highScore: 300, highestLevel: 2, totalDurationMs: 75_000, updatedAt: timestamp };
const progression = { schemaVersion: 2, serverRevision: 1, ...emptySourceProgression(), achievements: [], unlocks: [], settings: { revision: 0, musicVolume: 70, effectsVolume: 80, screenShake: true, reducedMotion: false } };
const run = { runId: "source_run_0001", score: 500, level: 2, durationMs: 25_000, statisticsSource: "demo" };
const event = validateGameSyncEvent({ eventId: run.runId, kind: "run.completed", version: 2, payload: run }).value;

function json(body) { return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }); }

test("successful sync acknowledgements survive decoding, including response-loss duplicate retries", async (context) => {
  const applied = new Map();
  let total = 0;
  let responseLost = true;
  context.mock.method(globalThis, "fetch", async (_path, init) => {
    assert.equal(init.credentials, "omit");
    const request = JSON.parse(init.body);
    const incoming = request.events[0];
    const duplicate = applied.has(incoming.eventId);
    if (!duplicate) { applied.set(incoming.eventId, canonicalJson(incoming)); total += incoming.payload.score; }
    else assert.equal(applied.get(incoming.eventId), canonicalJson(incoming));
    if (responseLost) { responseLost = false; throw new TypeError("Simulated connection loss after commit"); }
    return json({ profile: { ...profile, totalScore: total }, progression, results: [{ eventId: incoming.eventId, status: duplicate ? "duplicate" : "applied", unlockedAchievementIds: [] }] });
  });
  const queue = [event];
  await assert.rejects(postSync(queue, "test-token"), (error) => error.code === "network_error");
  assert.equal(queue.length, 1, "lost response leaves the queued event intact");
  const retry = await postSync(queue, "test-token");
  assert.equal(retry.results[0].status, "duplicate");
  assert.equal(retry.profile.totalScore, 500, "server applies a retried event only once");
  const acknowledgedIds = new Set(retry.results.map((result) => result.eventId));
  assert.equal(queue.filter((queued) => !acknowledgedIds.has(queued.eventId)).length, 0, "valid duplicate acknowledgement drains the queue");
});

test("sync decoder accepts applied and rejects missing, duplicate, or unrelated acknowledgements", async (context) => {
  let results = [{ eventId: event.eventId, status: "applied", unlockedAchievementIds: [] }];
  context.mock.method(globalThis, "fetch", async () => json({ profile, progression, results }));
  assert.equal((await postSync([event], "test-token")).results[0].status, "applied");
  for (const invalid of [undefined, [], [...results, ...results], [{ ...results[0], eventId: "unrelated_run" }]]) {
    results = invalid;
    await assert.rejects(postSync([event], "test-token"), (error) => error.code === "invalid_response");
  }
});

test("plain Vite HTML fallback is distinguished from an API response", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response("<!doctype html><html></html>", { headers: { "content-type": "text/html" } }));
  await assert.rejects(postSync([event], "test-token"), (error) => error.code === "API_NOT_AVAILABLE");
});

test("missing historical source remains absent from canonical validated event", () => {
  const legacyRun = { ...run };
  delete legacyRun.statisticsSource;
  const legacy = validateGameSyncEvent({ ...event, payload: legacyRun });
  assert.equal(legacy.ok, true);
  assert.equal(Object.hasOwn(legacy.value.payload, "statisticsSource"), false);
  assert.equal(canonicalJson(legacy.value).includes("statisticsSource"), false);
  assert.equal(validateRunSummary({ ...run, statisticsSource: "keyboard" }).ok, false);
  for (const statisticsSource of GAME_STATISTICS_SOURCES) {
    assert.equal(validateRunSummary({ ...run, statisticsSource }).value.statisticsSource, statisticsSource);
  }
});

test("legacy, demo, and Arduino local totals remain independent across persisted reloads", () => {
  let stats = addRunToStats(profile, run, timestamp);
  stats = addRunToStats(stats, { ...run, runId: "source_run_0002", score: 700, statisticsSource: "arduino" }, timestamp);
  assert.deepEqual(playerStatsSources(stats).legacy, playerStatsSources(profile).legacy);
  assert.equal(stats.sources.demo.totalScore, 500);
  assert.equal(stats.sources.arduino.totalScore, 700);
  assert.equal(stats.sources.legacy.totalScore, 600);
  assert.equal(stats.gamesPlayed, 5, "compatibility aggregate is preserved for older clients");
  const owner = "local_source_owner";
  const store = { version: 3, activeProfileId: owner, profiles: [{ profileId: owner, checkpointOwnerId: "source-owner", accessCode: null, authUserId: "f01b7e9c-67f6-420f-9434-777777777777", accountLinked: true, publicId: null, remoteConfirmed: true, pendingNickname: null, stats, progression, pendingEvents: [event], knownEventIds: [event.eventId] }] };
  const restored = sanitizeStoredGameStatsV3(JSON.parse(JSON.stringify(store)));
  assert.equal(restored.profiles.length, 1);
  assert.deepEqual(restored.profiles[0].stats.sources, stats.sources);
  assert.equal(restored.profiles[0].pendingEvents[0].payload.statisticsSource, "demo");
});

test("source progression separates counters, modes, and powers and validates every bucket", () => {
  const validated = validateRunSummary({ ...run, inputKind: "mixed", enemiesDestroyed: 3, shotsFired: 10, shotsHit: 4, powerupsCollected: 1, powers: [{ powerId: "shield", collectedCount: 1, activatedCount: 1 }] }).value;
  const demo = addRunToProgression(progression, validated, addRunToStats(profile, validated));
  const both = addRunToProgression(demo, { ...validated, statisticsSource: "arduino" }, profile);
  assert.equal(both.sources.demo.totals.arduinoRuns, 1, "controller achievement facts remain independent of launch source");
  assert.equal(both.sources.arduino.totals.arduinoRuns, 1);
  assert.equal(both.sources.demo.totals.enemiesDestroyed, 3);
  assert.equal(both.sources.arduino.modes[0].gamesPlayed, 1);
  assert.equal(both.sources.demo.powers[0].collectedCount, 1);
  assert.equal(validatePlayerProgression(both).ok, true);
  assert.equal(validatePlayerProgression({ ...both, sources: { ...both.sources, demo: null } }).ok, false);
});

test("source migration keeps historical data and default-deny database protections", () => {
  const migration = readFileSync(new URL("../db/migrations/0006_statistics_sources.sql", import.meta.url), "utf8");
  assert.match(migration, /DEFAULT 'legacy'/);
  assert.doesNotMatch(migration, /UPDATE\s+(?:public\.)?game_sync_events/i);
  assert.doesNotMatch(migration, /SECURITY\s+DEFINER/i);
  for (const table of ["stats", "totals", "mode_stats", "power_stats"]) {
    assert.match(migration, new RegExp(`ALTER TABLE public.game_player_source_${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`REVOKE ALL ON TABLE public.game_player_source_${table} FROM PUBLIC, anon, authenticated, service_role`));
  }
});


test("scoping an old profile keeps historical buckets available after a source switch", () => {
  const demo = playerStatsForSource(profile, "demo");
  assert.equal(demo.gamesPlayed, 0);
  assert.equal(playerStatsForSource(demo, "legacy").gamesPlayed, 3);
  const oldProgression = { ...progression, totals: { ...progression.totals, enemiesDestroyed: 12 } };
  const scoped = playerProgressionForSource(oldProgression, "demo");
  assert.equal(scoped.totals.enemiesDestroyed, 0);
  assert.equal(playerProgressionForSource(scoped, "legacy").totals.enemiesDestroyed, 12);
});


test("concurrent offline tabs union demo and Arduino queues without mixing source totals", () => {
  const other = validateGameSyncEvent({ ...event, eventId: "source_run_0002", payload: { ...run, runId: "source_run_0002", score: 700, statisticsSource: "arduino" } }).value;
  const store = (queued) => ({ version: 3, activeProfileId: "source-owner", profiles: [{
    profileId: "source-owner", checkpointOwnerId: "source-owner", accessCode: null,
    authUserId: "f01b7e9c-67f6-420f-9434-777777777777", accountLinked: true, publicId: null,
    remoteConfirmed: true, pendingNickname: null, stats: addRunToStats(profile, queued.payload, timestamp),
    progression: addRunToProgression(progression, queued.payload, profile),
    pendingEvents: [queued], knownEventIds: [queued.eventId],
  }] });
  const merged = mergeStoredGameStatsV3(store(event), store(other)).profiles[0];
  assert.equal(merged.pendingEvents.length, 2);
  assert.equal(merged.stats.sources.demo.totalScore, 500);
  assert.equal(merged.stats.sources.arduino.totalScore, 700);
  assert.equal(merged.stats.sources.legacy.totalScore, 600);
});
