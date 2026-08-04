import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import statsFunction from "../dist/api-test/api/stats.js";

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
  assert.match(source, /createLegacyPlayer/);
  assert.match(source, /recordLegacyRun/);
  assert.doesNotMatch(source, /CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE/i);
});

test("stats source verifies bearer tokens after the matrix check and before SQL", async () => {
  const source = await readFile(
    new URL("../api/stats.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /from "\.\.\/server\/authVerify\.js"/);
  assert.doesNotMatch(source, /Readable\.toWeb|ServerResponse|IncomingMessage/);

  // The link handler lives inside handlePost: bearer verification must run
  // before its rate-limit consumption (and thus before any SQL), and the
  // credential-matrix check must come before verification.
  const handlePostSource = source.slice(
    source.indexOf("async function handlePost"),
  );
  const matrixIndex = handlePostSource.indexOf("evaluateCredentialMatrix(");
  const verifyIndex = handlePostSource.indexOf("verifySupabaseToken(");
  const rateLimitIndex = handlePostSource.indexOf("enforceMutationRateLimits(");
  const linkCaseIndex = handlePostSource.indexOf('case "link"');
  assert.ok(matrixIndex > -1, "handlePost must call evaluateCredentialMatrix");
  assert.ok(verifyIndex > -1, "handlePost must call verifySupabaseToken");
  assert.ok(rateLimitIndex > -1, "handlePost must consume rate limits");
  assert.ok(linkCaseIndex > -1, "handlePost must handle the link action");
  assert.ok(matrixIndex < verifyIndex);
  assert.ok(verifyIndex < rateLimitIndex);
  assert.ok(verifyIndex < linkCaseIndex);

  // The link/unlink transactions must check session revocation.
  assert.match(source, /FROM auth\.sessions/);
  assert.match(source, /AUTH_SESSION_REVOKED/);
  // The account create path retries with ON CONFLICT DO NOTHING and never
  // adopts an existing profile row.
  assert.match(source, /ON CONFLICT \(access_code_hash\) DO NOTHING/);
  assert.match(source, /ip_link/);
  assert.match(source, /account_link/);
});

test("stats API rejects link without a bearer before touching the database", async () => {
  const previousDatabaseUrl = process.env.SUPABASE_DATABASE_URL;
  process.env.SUPABASE_DATABASE_URL = unreachableTestDatabaseUrl();

  try {
    const response = await statsFunction.fetch(
      new Request("https://example.test/api/stats", {
        body: JSON.stringify({
          action: "link",
          accessCode: "01234-56789-ABCDE-FGHJK",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "AUTH_TOKEN_MISSING");
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.SUPABASE_DATABASE_URL;
    } else {
      process.env.SUPABASE_DATABASE_URL = previousDatabaseUrl;
    }
  }
});

test("stats API enforces the credential matrix before verification and SQL", async () => {
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
    // session is bearer-only: an access code is mixed credentials.
    const sessionMixed = await post(
      { action: "session", accessCode: "01234-56789-ABCDE-FGHJK" },
      { authorization: "Bearer not-a-token" },
    );
    assert.equal(sessionMixed.status, 400);
    assert.equal((await sessionMixed.json()).code, "MIXED_CREDENTIALS");

    // session without any credential is a missing token.
    const sessionMissing = await post({ action: "session" });
    assert.equal(sessionMissing.status, 401);
    assert.equal((await sessionMissing.json()).code, "AUTH_TOKEN_MISSING");

    // rename accepts exactly one credential.
    const renameMixed = await post(
      {
        action: "rename",
        accessCode: "01234-56789-ABCDE-FGHJK",
        nickname: "Pilot",
      },
      { authorization: "Bearer not-a-token" },
    );
    assert.equal(renameMixed.status, 400);
    assert.equal((await renameMixed.json()).code, "MIXED_CREDENTIALS");

    // connect never accepts a bearer (bearer users call session).
    const connectBearer = await post(
      { action: "connect" },
      { authorization: "Bearer not-a-token" },
    );
    assert.equal(connectBearer.status, 400);
    assert.equal((await connectBearer.json()).code, "MIXED_CREDENTIALS");

    // A structurally invalid bearer fails verification before any SQL.
    const linkBadToken = await post(
      { action: "link", accessCode: "01234-56789-ABCDE-FGHJK" },
      { authorization: "Bearer not-a-token" },
    );
    assert.equal(linkBadToken.status, 401);
    assert.equal((await linkBadToken.json()).code, "AUTH_TOKEN_INVALID");

    // An Authorization header that carries no usable bearer token must not
    // turn a code request into mixed credentials: the token is parsed before
    // the matrix runs, so these stay on the access-code path.
    for (const authorization of ["", "   ", "Basic dXNlcjpwYXNz", "Bearer"]) {
      const codeWithJunkHeader = await post(
        { action: "create", accessCode: "invalid", language: "uk" },
        { authorization },
      );
      assert.equal(codeWithJunkHeader.status, 400, authorization);
      assert.equal(
        (await codeWithJunkHeader.json()).code,
        "INVALID_ACCESS_CODE",
        authorization,
      );
    }

    // Bearer-required actions still fail closed on such a header.
    const sessionJunkHeader = await post(
      { action: "session" },
      { authorization: "Basic dXNlcjpwYXNz" },
    );
    assert.equal(sessionJunkHeader.status, 401);
    assert.equal((await sessionJunkHeader.json()).code, "AUTH_TOKEN_MISSING");

    // Identity-looking fields are stripped, never a hard failure.
    const strippedIdentity = await post({
      action: "create",
      accessCode: "invalid",
      language: "uk",
      userId: "1",
      email: "a@b.c",
      authUserId: "x",
      sub: "y",
    });
    assert.equal(strippedIdentity.status, 400);
    assert.equal((await strippedIdentity.json()).code, "INVALID_ACCESS_CODE");
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
          accessCode: "invalid",
          language: "uk",
          nickname: "Test player",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      code: "INVALID_ACCESS_CODE",
      error: "Access code must contain 20 valid Base32 characters.",
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
          accessCode: "01234-56789-ABCDE-FGHJK",
          events: Array.from({ length: 6 }, (_, index) => event(index)),
        }),
        headers: { "content-type": "application/json" },
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
