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
  assert.doesNotMatch(source, /CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE/i);
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
