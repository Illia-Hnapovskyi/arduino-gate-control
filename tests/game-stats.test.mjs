import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAccessCode,
  generateAccessCode,
  generateRandomNickname,
  generateRunId,
  normalizeAccessCode,
  normalizeNickname,
  validateAccessCode,
  validateLanguage,
  validateNickname,
  validateRun,
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
