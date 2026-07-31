import assert from "node:assert/strict";
import test from "node:test";

import statsFunction from "../dist/api-test/api/stats.js";

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
  const response = await statsFunction.fetch(
    new Request("https://example.test/api/stats", {
      body: JSON.stringify({
        action: "create",
        accessCode: "0123456789ABCDEFGHJK",
        language: "uk",
        nickname: "Test player",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    code: "DATABASE_NOT_CONFIGURED",
    error: "Game statistics require SUPABASE_DATABASE_URL.",
  });
});
