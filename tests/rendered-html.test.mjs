import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GAME_COPY, PAGE_COPY } from "../app/i18n.ts";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("production build contains the app shell and referenced assets", async () => {
  const html = await readFile(path.join(projectRoot, "dist/index.html"), "utf8");
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /Arduino Gate \+ Radar \+ Joystick Game/);

  const assetPaths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)]
    .map((match) => match[1]);
  assert.ok(assetPaths.length >= 2, "expected built JavaScript and CSS assets");

  await Promise.all(
    assetPaths.map((assetPath) =>
      access(path.join(projectRoot, "dist", assetPath.slice(1))),
    ),
  );
});

test("production build includes the downloadable firmware and instructions", async () => {
  const firmware = await readFile(
    path.join(projectRoot, "dist/arduino-smart-gate.ino"),
    "utf8",
  );
  const instructions = await readFile(
    path.join(projectRoot, "dist/README-UK.md"),
    "utf8",
  );

  assert.match(firmware, /ACTIVE_BUZZER_PIN = 5/);
  assert.match(firmware, /Serial\.begin\(115200\)/);
  assert.match(instructions, /Active Buzzer/);
  assert.match(instructions, /D5/);
});

test("all languages expose the same page and game translation keys", () => {
  for (const translations of [PAGE_COPY, GAME_COPY]) {
    const expectedKeys = Object.keys(translations.uk).sort();
    assert.deepEqual(Object.keys(translations.de).sort(), expectedKeys);
    assert.deepEqual(Object.keys(translations.en).sort(), expectedKeys);
  }
});
