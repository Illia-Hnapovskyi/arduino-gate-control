import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import statsFunction from "../dist/api-test/api/stats.js";

async function requestStats(init) {
  const server = createServer(statsFunction);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert(address && typeof address === "object");
    return await fetch(`http://127.0.0.1:${address.port}/api/stats`, init);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("stats API exports a Vercel-compatible handler and reports missing Supabase configuration", async () => {
  const previousDatabaseUrl = process.env.SUPABASE_DATABASE_URL;
  delete process.env.SUPABASE_DATABASE_URL;

  try {
    assert.equal(typeof statsFunction, "function");
    const response = await requestStats();

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
  const response = await requestStats({ method: "DELETE" });

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, POST");
});
