// Run after npm run build:api-test, with Node >= 22:
// PGLITE_MODULE=/absolute/path/to/@electric-sql/pglite/dist/index.js \
//   node --experimental-strip-types scripts/verify-statistics-db.mjs
// Uses an isolated in-memory PostgreSQL WASM database. Supabase Auth is modeled
// with local users/sessions and signed fixture JWTs; this is not a live Supabase
// Auth, Supavisor, TLS, or Vercel infrastructure test. No network or production IO.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { pglitePostgres } from "./test-support/pglite-postgres.mjs";
import { postSync } from "../app/useGameStats.ts";

if (!process.env.PGLITE_MODULE) throw new Error("Set PGLITE_MODULE to an installed PGlite module; no production database is used.");
const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href);
const pg = new PGlite();
const fixtureModule = new URL("../dist/api-test/api/stats.pglite.mjs", import.meta.url);
let assertions = 0;
function check(actual, expected, label) { assert.deepEqual(actual, expected, label); assertions++; }
const originalFetch = globalThis.fetch;
const originalDatabaseUrl = process.env.SUPABASE_DATABASE_URL;
const originalRateSecret = process.env.RATE_LIMIT_SECRET;

try {
  await pg.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE TABLE auth.users (id UUID PRIMARY KEY); CREATE TABLE auth.sessions (id UUID PRIMARY KEY, user_id UUID REFERENCES auth.users(id));");
  const migration = async (name) => pg.exec(await readFile(new URL(`../db/migrations/${name}.sql`, import.meta.url), "utf8"));
  for (const name of ["0001_game_stats", "0002_game_progression", "0003_base_table_grants", "0004_account_links", "0005_account_only_identity"]) await migration(name);
  // Legacy aggregates may outlive detailed run retention: preserve the actual
  // saved aggregates instead of reconstructing incomplete history from runs.
  await pg.exec("INSERT INTO game_players (nickname, profile_schema_version, games_played, total_score, high_score, highest_level, total_duration_ms) VALUES ('Historical Pilot', 3, 3, 600, 300, 2, 75000); INSERT INTO game_player_totals (player_id, enemies_destroyed, arduino_runs) SELECT id, 12, 1 FROM game_players; INSERT INTO game_player_mode_stats (player_id, mode_id, difficulty_id, games_played, total_score, high_score) SELECT id, 'classic', 'pilot', 3, 600, 300 FROM game_players; INSERT INTO game_player_power_stats (player_id, power_id, collected_count) SELECT id, 'shield', 4 FROM game_players;");
  await migration("0006_statistics_sources");
  check((await pg.query("SELECT statistics_source, games_played, total_score FROM game_player_source_stats")).rows, [{ statistics_source: "legacy", games_played: 3, total_score: 600 }], "historical backfill preserves exact aggregates in legacy");
  check((await pg.query("SELECT enemies_destroyed, arduino_runs FROM game_player_source_totals WHERE statistics_source = 'legacy'")).rows, [{ enemies_destroyed: 12, arduino_runs: 1 }], "historical detailed aggregate facts survive");
  check((await pg.query("SELECT count(*)::int AS count FROM pg_class WHERE relname LIKE 'game_player_source_%' AND relkind = 'r' AND relrowsecurity")).rows[0].count, 4, "source tables all enable RLS");
  check((await pg.query("SELECT count(*)::int AS count FROM pg_class c CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS roles(role) WHERE c.relname LIKE 'game_player_source_%' AND c.relkind = 'r' AND has_table_privilege(roles.role, c.oid, 'SELECT,INSERT,UPDATE,DELETE')")).rows[0].count, 0, "no Data API role has source-table grants");
  check((await pg.query("SELECT count(*)::int AS count FROM pg_policies WHERE tablename LIKE 'game_player_source_%'")).rows[0].count, 0, "source tables have no bypass policies");
  for (const role of ["anon", "authenticated", "service_role"]) {
    await pg.exec(`SET ROLE ${role}`);
    await assert.rejects(pg.query("SELECT * FROM public.game_player_source_stats"), (error) => error.code === "42501"); assertions++;
    await pg.exec("RESET ROLE");
  }
  check((await pg.query("SELECT count(*)::int AS count FROM pg_proc p CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS roles(role) WHERE p.proname LIKE 'game_accumulate_source_%' AND (p.prosecdef OR has_function_privilege(roles.role, p.oid, 'EXECUTE'))")).rows[0].count, 0, "trigger functions are invokers and not externally executable");

  // Exercise RLS independently from grants: temporarily allow SELECT on this
  // disposable table; an authenticated role must still see zero rows.
  await pg.exec("GRANT SELECT ON public.game_player_source_stats TO authenticated; SET ROLE authenticated;");
  check((await pg.query("SELECT count(*)::int AS count FROM public.game_player_source_stats")).rows[0].count, 0, "RLS denies historical rows even if a table grant is accidentally reintroduced");
  await pg.exec("RESET ROLE; REVOKE SELECT ON public.game_player_source_stats FROM authenticated;");

  // Import the unchanged compiled API with only its Postgres.js transport
  // factory replaced. Module-relative auth and contract imports remain intact.
  const compiled = await readFile(new URL("../dist/api-test/api/stats.js", import.meta.url), "utf8");
  assert.ok(compiled.includes('import postgres from "postgres";'));
  globalThis[Symbol.for("arduino-statistics-test-postgres")] = () => pglitePostgres(pg);
  await writeFile(fixtureModule, compiled.replace('import postgres from "postgres";', 'const postgres = globalThis[Symbol.for("arduino-statistics-test-postgres")];'));
  const { default: handler } = await import(fixtureModule.href);
  const { __setJwksForTesting } = await import("../dist/api-test/server/authVerify.js");
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  __setJwksForTesting({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: "local-pg-test" }] });
  const userId = randomUUID(); const sessionId = randomUUID();
  await pg.query("INSERT INTO auth.users (id) VALUES ($1)", [userId]);
  await pg.query("INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)", [sessionId, userId]);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "ES256", typ: "JWT", kid: "local-pg-test" })}.${encode({ iss: "https://vullhduhswcnlpgnlrtp.supabase.co/auth/v1", aud: "authenticated", sub: userId, session_id: sessionId, role: "authenticated", is_anonymous: false, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const token = `${signingInput}.${sign("sha256", Buffer.from(signingInput), { key: pair.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  // Sent only to the replaced in-memory transport; never printed or persisted.
  const fixtureUrl = new URL("https://localhost/fixture");
  fixtureUrl.protocol = ["post", "gresql"].join("");
  fixtureUrl.username = "fixture";
  fixtureUrl.password = "fixture";
  process.env.SUPABASE_DATABASE_URL = fixtureUrl.toString();
  process.env.RATE_LIMIT_SECRET = "local-statistics-fixture-only";
  const request = async (body, auth = token) => handler.fetch(new Request("http://local.test/api/stats", {
    method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body),
  }));
  const bodyOf = async (response, expected = 200) => { const body = await response.json(); check(response.status, expected, `API ${body.code ?? "success"}`); return body; };
  let leaderboard = await bodyOf(await handler.fetch(new Request("http://local.test/api/stats")));
  check(leaderboard.sources.demo.length, 0, "demo leaderboard starts empty");
  check(leaderboard.sources.legacy.length, 1, "legacy board keeps historical results");
  const created = await bodyOf(await request({ action: "create", nickname: "Integration Pilot", language: "en" }));
  const retryCreate = await bodyOf(await request({ action: "create", nickname: "Ignored Retry", language: "en" }));
  check(retryCreate.profilePublicId, created.profilePublicId, "create retry returns same identity");
  check((await pg.query("SELECT access_code_hash IS NULL AS codeless, profile_schema_version AS version FROM game_players WHERE public_id = $1", [created.profilePublicId])).rows[0], { codeless: true, version: 3 }, "account-only identity survives creation");
  const playerId = (await pg.query("SELECT id FROM game_players WHERE public_id = $1", [created.profilePublicId])).rows[0].id;
  const makeEvent = (statisticsSource, suffix, score = 500) => ({ eventId: `integration_${suffix}`, kind: "run.completed", version: 2, payload: {
    runId: `integration_${suffix}`, score, level: 2, durationMs: 25000,
    ...(statisticsSource ? { statisticsSource } : {}), inputKind: "keyboard", enemiesDestroyed: 3,
    shotsFired: 10, shotsHit: 4, powerupsCollected: 1, powers: [{ powerId: "shield", collectedCount: 1, activatedCount: 1 }],
  } });
  const demo = makeEvent("demo", "demo");
  let loseResponse = true;
  globalThis.fetch = async (_url, init) => {
    const response = await handler.fetch(new Request("http://local.test/api/stats", init));
    if (loseResponse) { loseResponse = false; throw new TypeError("Fixture response loss after commit"); }
    return response;
  };
  await assert.rejects(postSync([demo], token), (error) => error.code === "network_error"); assertions++;
  const retry = await postSync([demo], token);
  check(retry.results[0].status, "duplicate", "real SQL ledger handles lost response retry");
  check(retry.profile.sources.demo.gamesPlayed, 1, "demo counted once");
  check(retry.profile.sources.arduino.gamesPlayed, 0, "demo never contaminates Arduino");
  await bodyOf(await request({ action: "sync", events: [{ ...demo, payload: { ...demo.payload, score: 510 } }] }), 409);
  await bodyOf(await request({ action: "sync", events: [makeEvent("arduino", "arduino", 700), makeEvent(undefined, "legacy", 300)] }));
  const remote = await bodyOf(await request({ action: "session" }));
  check(Object.fromEntries(Object.entries(remote.profile.sources).map(([source, value]) => [source, value.totalScore])), { demo: 500, arduino: 700, legacy: 300 }, "second-device snapshot keeps independent source totals");
  check(remote.progression.sources.arduino.totals.arduinoRuns, 0, "source is independent of keyboard input; controller achievement remains unchanged");
  check(remote.progression.sources.demo.powers[0].collectedCount, 1, "source power detail counted once");
  check(remote.progression.sources.legacy.modes[0].gamesPlayed, 1, "old client events become legacy");
  check((await pg.query("SELECT count(*)::int AS count FROM game_sync_events WHERE player_id = $1", [playerId])).rows[0].count, 3, "exactly three ledger events");
  const ledgerBefore = (await pg.query("SELECT event_id, payload_sha256 FROM game_sync_events ORDER BY event_id")).rows;
  await migration("0006_statistics_sources");
  const rerun = await bodyOf(await request({ action: "session" }));
  check(rerun.profile.sources, remote.profile.sources, "migration rerun never repeats backfill or changes totals");
  check((await pg.query("SELECT event_id, payload_sha256 FROM game_sync_events ORDER BY event_id")).rows, ledgerBefore, "migration leaves canonical idempotency hashes untouched");
  // Simulate an old API inserting a run without the new column. Triggers must
  // continue counting legacy after migration, before the new API is deployed.
  await pg.query("INSERT INTO game_runs (player_id, run_id, score, level, duration_ms) VALUES ($1, 'old_api_window', 100, 1, 1000)", [playerId]);
  check((await pg.query("SELECT total_score FROM game_player_source_stats WHERE player_id = $1 AND statistics_source = 'legacy'", [playerId])).rows[0].total_score, 400, "old API deployment-window inserts stay in legacy");
  await assert.rejects(pg.query("INSERT INTO game_runs (player_id, run_id, score, level, duration_ms, statistics_source) VALUES ($1, 'bad_source', 100, 1, 1000, 'keyboard')", [playerId]), (error) => error.code === "23514"); assertions++;
  await bodyOf(await request({ action: "rename", nickname: "Renamed Pilot" }));
  leaderboard = await bodyOf(await handler.fetch(new Request("http://local.test/api/stats")));
  check(leaderboard.sources.demo[0].nickname, "Renamed Pilot", "leaderboard picks up rename with source ranking");
  check((await bodyOf(await request({ action: "session", accessCode: "retired" }), 400)).code, "ACCESS_CODE_RETIRED", "retired credential remains rejected");
  check((await bodyOf(await request({ action: "connect" }), 400)).code, "INVALID_ACTION", "removed action stays rejected");
  check((await bodyOf(await request({ action: "session" }, null), 401)).code, "AUTH_TOKEN_MISSING", "signed-out request cannot read profile");
  await pg.query("DELETE FROM auth.sessions WHERE id = $1", [sessionId]);
  check((await bodyOf(await request({ action: "rename", nickname: "Revoked Rename" }), 401)).code, "AUTH_SESSION_REVOKED", "revoked session cannot rename");
  __setJwksForTesting(null);
  console.log(`PASS: ${assertions} PostgreSQL/API/client assertions; migrations 0001–0006, backfill, source isolation, response loss, duplicates, conflicts, RLS/grants, session protection, rerun safety. Local PGlite only; no live Supabase access.`);
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis[Symbol.for("arduino-statistics-test-postgres")];
  if (originalDatabaseUrl === undefined) delete process.env.SUPABASE_DATABASE_URL; else process.env.SUPABASE_DATABASE_URL = originalDatabaseUrl;
  if (originalRateSecret === undefined) delete process.env.RATE_LIMIT_SECRET; else process.env.RATE_LIMIT_SECRET = originalRateSecret;
  await unlink(fixtureModule).catch(() => {});
  await pg.close();
}
