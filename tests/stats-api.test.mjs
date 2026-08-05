import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after, beforeEach } from "node:test";

import statsFunction from "../dist/api-test/api/stats.js";
import { __setJwksForTesting } from "../dist/api-test/server/authVerify.js";

const ISSUER = "https://vullhduhswcnlpgnlrtp.supabase.co/auth/v1";

// The handler verifies a bearer token before it reaches any SQL, so the tests
// that need to get past verification seed the same JWKS cache the auth tests
// use and mint a real ES256 token. Nothing here contacts the network.
const keyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = { ...keyPair.publicKey.export({ format: "jwk" }), kid: "ec-key" };

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function validBearerToken() {
  const now = Math.floor(Date.now() / 1000);
  const signingInput = [
    base64urlJson({ alg: "ES256", typ: "JWT", kid: "ec-key" }),
    base64urlJson({
      iss: ISSUER,
      aud: "authenticated",
      exp: now + 3_600,
      iat: now,
      sub: randomUUID(),
      role: "authenticated",
      is_anonymous: false,
      session_id: randomUUID(),
    }),
  ].join(".");
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: keyPair.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

beforeEach(() => {
  __setJwksForTesting({ keys: [jwk] });
});

after(() => {
  __setJwksForTesting(null);
});

function unreachableTestDatabaseUrl() {
  const url = new URL("https://example.invalid:6543/test");
  url.protocol = ["post", "gresql"].join("");
  url.username = "test";
  url.password = "test";
  return url.toString();
}

test("stats source keeps the Web handler, weighted rollover, and consistent snapshots", async () => {
  const source = await readFile(
    new URL("../api/stats.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /from "\.\.\/shared\/gameStats\.js"/);
  assert.match(source, /export default \{\s*fetch\(request: Request\)/s);
  assert.doesNotMatch(source, /Readable\.toWeb|ServerResponse|IncomingMessage/);
  assert.match(source, /THEN \$\{amount\}\s*ELSE game_rate_limits\.request_count/s);
  assert.match(source, /isolation level repeatable read read only/);
  assert.match(source, /to_regclass\('public\.game_sync_events'\)/);
  assert.match(source, /SCHEMA_MIGRATION_REQUIRED/);
  assert.doesNotMatch(source, /CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE/i);
});

test("stats source verifies bearer tokens after the matrix check and before SQL", async () => {
  const source = await readFile(
    new URL("../api/stats.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /from "\.\.\/server\/authVerify\.js"/);
  assert.doesNotMatch(source, /Readable\.toWeb|ServerResponse|IncomingMessage/);

  // Inside handlePost the credential-matrix check must come before bearer
  // verification, and verification before the first rate-limit consumption
  // (and therefore before any SQL) and before every action handler.
  const handlePostSource = source.slice(
    source.indexOf("async function handlePost"),
  );
  const matrixIndex = handlePostSource.indexOf("evaluateCredentialMatrix(");
  const verifyIndex = handlePostSource.indexOf("verifySupabaseToken(");
  const rateLimitIndex = handlePostSource.indexOf("enforceMutationRateLimits(");
  const createCaseIndex = handlePostSource.indexOf('case "create"');
  assert.ok(matrixIndex > -1, "handlePost must call evaluateCredentialMatrix");
  assert.ok(verifyIndex > -1, "handlePost must call verifySupabaseToken");
  assert.ok(rateLimitIndex > -1, "handlePost must consume rate limits");
  assert.ok(createCaseIndex > -1, "handlePost must handle the create action");
  assert.ok(matrixIndex < verifyIndex);
  assert.ok(verifyIndex < rateLimitIndex);
  assert.ok(verifyIndex < createCaseIndex);

  // create and rename establish or change the identity, so both check session
  // revocation inside their transaction.
  assert.match(source, /FROM auth\.sessions/);
  assert.match(source, /AUTH_SESSION_REVOKED/);

  // An account-only profile is inserted with no digest and schema version 3 —
  // the pair that satisfies game_players_reachable_check — and its link row is
  // written in the same transaction.
  assert.match(
    source,
    /INSERT INTO game_players \(\s*access_code_hash, nickname, language, profile_schema_version\s*\)\s*VALUES \(\s*NULL,/,
  );
  assert.match(source, /const ACCOUNT_PROFILE_SCHEMA_VERSION = 3;/);
  assert.match(
    source,
    /INSERT INTO game_account_links \(player_id, auth_user_id, link_method\)\s*VALUES \(\$\{playerId\}, \$\{auth\.userId\}, 'create'\)/,
  );

  // Profile-scoped rate limits key on the auth user, never on a raw id and
  // never on the retired digest.
  assert.match(source, /pseudonymizeRateLimitScope\(`account:\$\{authUserId\}`\)/);
  assert.doesNotMatch(source, /profile:\$\{/);
  assert.match(source, /account_link/);
  assert.doesNotMatch(source, /ip_link/);

  // The server neither accepts, mints, hashes nor returns an access code.
  assert.doesNotMatch(
    source,
    /generateAccessCode|formatAccessCode|validateAccessCode|hashAccessCode|access_code_hash = /,
  );
});

test("stats API refuses the retired code-era actions and any access code", async () => {
  const previousDatabaseUrl = process.env.SUPABASE_DATABASE_URL;
  process.env.SUPABASE_DATABASE_URL = unreachableTestDatabaseUrl();

  const post = (body, headers = {}) =>
    statsFunction.fetch(
      new Request("https://example.test/api/stats", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
      }),
    );

  try {
    // connect/link/unlink are gone: they fail the action allowlist like any
    // unknown action, before credentials are even inspected.
    for (const action of ["connect", "link", "unlink"]) {
      const removed = await post({
        action,
        accessCode: "01234-56789-ABCDE-FGHJK",
      });
      assert.equal(removed.status, 400, action);
      assert.equal((await removed.json()).code, "INVALID_ACTION", action);
    }

    // A surviving action carrying a code is refused explicitly, so an old
    // cached bundle gets a diagnosable 400 instead of a confusing 401.
    for (const body of [
      { action: "create", accessCode: "01234-56789-ABCDE-FGHJK", language: "uk" },
      { action: "rename", accessCode: "01234-56789-ABCDE-FGHJK", nickname: "Pilot" },
      { action: "session", accessCode: "01234-56789-ABCDE-FGHJK" },
    ]) {
      const retired = await post(body);
      assert.equal(retired.status, 400, body.action);
      assert.deepEqual(await retired.json(), {
        code: "ACCESS_CODE_RETIRED",
        error: "Access codes are no longer accepted. Sign in instead.",
      });
    }

    // A bearer token does not rescue a request that still carries a code.
    const bothCredentials = await post(
      { action: "session", accessCode: "01234-56789-ABCDE-FGHJK" },
      { authorization: `Bearer ${validBearerToken()}` },
    );
    assert.equal(bothCredentials.status, 400);
    assert.equal((await bothCredentials.json()).code, "ACCESS_CODE_RETIRED");
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.SUPABASE_DATABASE_URL;
    } else {
      process.env.SUPABASE_DATABASE_URL = previousDatabaseUrl;
    }
  }
});

test("stats API requires a verified bearer before touching the database", async () => {
  const previousDatabaseUrl = process.env.SUPABASE_DATABASE_URL;
  process.env.SUPABASE_DATABASE_URL = unreachableTestDatabaseUrl();

  const post = (body, headers = {}) =>
    statsFunction.fetch(
      new Request("https://example.test/api/stats", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
      }),
    );

  try {
    // Every action is bearer-only, so no credential is a missing token.
    for (const body of [
      { action: "create", language: "uk" },
      { action: "rename", nickname: "Pilot" },
      { action: "session" },
    ]) {
      const missing = await post(body);
      assert.equal(missing.status, 401, body.action);
      assert.equal((await missing.json()).code, "AUTH_TOKEN_MISSING", body.action);
    }

    // An Authorization header that carries no usable bearer token counts as no
    // credential at all rather than reaching verification.
    for (const authorization of ["", "   ", "Basic dXNlcjpwYXNz", "Bearer"]) {
      const junkHeader = await post({ action: "session" }, { authorization });
      assert.equal(junkHeader.status, 401, authorization);
      assert.equal(
        (await junkHeader.json()).code,
        "AUTH_TOKEN_MISSING",
        authorization,
      );
    }

    // A structurally invalid bearer fails verification before any SQL.
    const badToken = await post(
      { action: "session" },
      { authorization: "Bearer not-a-token" },
    );
    assert.equal(badToken.status, 401);
    assert.equal((await badToken.json()).code, "AUTH_TOKEN_INVALID");

    // Identity-looking fields are stripped, never a hard failure: the request
    // still fails only for its missing token.
    const strippedIdentity = await post({
      action: "create",
      language: "uk",
      userId: "1",
      email: "a@b.c",
      authUserId: "x",
      sub: "y",
    });
    assert.equal(strippedIdentity.status, 401);
    assert.equal((await strippedIdentity.json()).code, "AUTH_TOKEN_MISSING");
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.SUPABASE_DATABASE_URL;
    } else {
      process.env.SUPABASE_DATABASE_URL = previousDatabaseUrl;
    }
  }
});

test("stats API exports a Vercel-compatible handler and reports missing Supabase configuration", async () => {
  const previousDatabaseUrl = process.env.SUPABASE_DATABASE_URL;
  delete process.env.SUPABASE_DATABASE_URL;

  try {
    assert.equal(typeof statsFunction.fetch, "function");
    const response = await statsFunction.fetch(
      new Request("https://example.test/api/stats"),
    );

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      code: "DATABASE_NOT_CONFIGURED",
      error: "Game statistics require SUPABASE_DATABASE_URL.",
    });
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.SUPABASE_DATABASE_URL;
    } else {
      process.env.SUPABASE_DATABASE_URL = previousDatabaseUrl;
    }
  }
});

test("stats API rejects unsupported methods before opening the database", async () => {
  const response = await statsFunction.fetch(
    new Request("https://example.test/api/stats", { method: "DELETE" }),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, POST");
});

test("stats API fetch handler accepts a standard JSON Request", async () => {
  const previousDatabaseUrl = process.env.SUPABASE_DATABASE_URL;
  process.env.SUPABASE_DATABASE_URL = unreachableTestDatabaseUrl();

  try {
    const response = await statsFunction.fetch(
      new Request("https://example.test/api/stats", {
        body: JSON.stringify({
          action: "create",
          language: "forged",
          nickname: "Test player",
        }),
        headers: {
          authorization: `Bearer ${validBearerToken()}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );

    // Reaching language validation proves the JSON body was parsed and the
    // verified bearer carried the request that far without any SQL.
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      code: "INVALID_LANGUAGE",
      error: "Unsupported language.",
    });
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.SUPABASE_DATABASE_URL;
    } else {
      process.env.SUPABASE_DATABASE_URL = previousDatabaseUrl;
    }
  }
});

test("stats API rejects an oversized v2 event batch before querying Postgres", async () => {
  const previousDatabaseUrl = process.env.SUPABASE_DATABASE_URL;
  process.env.SUPABASE_DATABASE_URL = unreachableTestDatabaseUrl();
  const event = (index) => ({
    eventId: `run_0123456789ABCDE${index}`,
    kind: "run.completed",
    version: 2,
    payload: {
      runId: `run_0123456789ABCDE${index}`,
      score: 0,
      level: 1,
      durationMs: 0,
    },
  });

  try {
    const response = await statsFunction.fetch(
      new Request("https://example.test/api/stats", {
        body: JSON.stringify({
          action: "sync",
          events: Array.from({ length: 6 }, (_, index) => event(index)),
        }),
        headers: {
          authorization: `Bearer ${validBearerToken()}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      code: "INVALID_SYNC_EVENTS",
      error: "Sync requests must contain 1-5 events.",
    });
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.SUPABASE_DATABASE_URL;
    } else {
      process.env.SUPABASE_DATABASE_URL = previousDatabaseUrl;
    }
  }
});
