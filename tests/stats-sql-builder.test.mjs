import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { pglitePostgres } from "../scripts/test-support/pglite-postgres.mjs";

const api = readFileSync(new URL("../dist/api-test/api/stats.js", import.meta.url), "utf8");
const fixtures = {
  game_run_power_stats: [{ run_id: 1, power_id: "shield", collected_count: 1, activated_count: 1 }],
  game_run_sector_stats: [{ run_id: 1, sector_index: 0, sector_id: "starfield", completed: true, lives_lost: 0, duration_ms: 22000 }],
  game_player_power_stats: [{ player_id: 1, power_id: "shield", collected_count: 1, activated_count: 1, updated_at: new Date("2026-10-03T12:00:00Z") }],
};

for (const [table, rows] of Object.entries(fixtures)) {
  test(`the API ${table} batch compiles through the installed Postgres.js builder`, async () => {
    // Execute the actual compiled-handler tag, including its surrounding SQL:
    // an explicit column list before sql(rows, columns) used to select the
    // identifier builder and throw before any SQL reached PostgreSQL.
    const tag = api.match(new RegExp("await sql\\s*`(\\s*INSERT INTO " + table + "\\b[\\s\\S]*?)`;"))?.[1];
    assert.ok(tag, `missing batch insert for ${table}`);
    const captured = [];
    const sql = pglitePostgres({ query: async (query, parameters) => {
      captured.push({ query, parameters });
      return { rows: [] };
    } });
    const execute = new Function("sql", "powerRows", "sectorRows", "playerPowerRows", "MAX_SAFE_DATABASE_INTEGER", "return sql`" + tag + "`; ");
    await execute(sql, rows, rows, rows, Number.MAX_SAFE_INTEGER);
    assert.equal(captured.length, 1);
    assert.match(captured[0].query, /\)values\(/i);
    assert.doesNotMatch(captured[0].query, /shield|starfield/, "facts must remain bound parameters");
    assert.deepEqual(captured[0].parameters.slice(0, Object.keys(rows[0]).length), Object.values(rows[0]).map(value => value instanceof Date ? value.toISOString() : value));
  });
}
