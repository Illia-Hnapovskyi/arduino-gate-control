import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GAME_KEY_BINDINGS,
  GAME_PREFERENCES_STORAGE_KEY,
  effectiveReducedMotion,
  loadGamePreferences,
  rebindGameAction,
  sanitizeGamePreferences,
  saveGamePreferences,
} from "../app/game/preferences.ts";

test("game preferences sanitize volume, motion, and remappable keys", () => {
  const preferences = sanitizeGamePreferences({
    effectsVolume: 140,
    musicVolume: -8,
    reducedMotion: true,
    screenShake: false,
    keyBindings: { fire: "KeyF", moveUp: "<script>" },
  });

  assert.equal(preferences.effectsVolume, 100);
  assert.equal(preferences.invertArduinoY, true);
  assert.equal(preferences.musicVolume, 0);
  assert.equal(preferences.reducedMotion, true);
  assert.equal(preferences.screenShake, false);
  assert.equal(preferences.keyBindings.fire, "KeyF");
  assert.equal(preferences.keyBindings.moveUp, DEFAULT_GAME_KEY_BINDINGS.moveUp);
});

test("game preferences round-trip through storage and honour system motion", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const preferences = sanitizeGamePreferences({
    musicVolume: 73,
    keyBindings: { power: "ShiftLeft" },
  });

  saveGamePreferences(storage, preferences);
  assert.ok(values.has(GAME_PREFERENCES_STORAGE_KEY));
  assert.deepEqual(loadGamePreferences(storage), preferences);
  assert.equal(effectiveReducedMotion(false, true), true);
  assert.equal(effectiveReducedMotion(false, false), false);
});

test("remapping swaps conflicts and rejects reserved pause or arrow aliases", () => {
  const swapped = rebindGameAction(
    DEFAULT_GAME_KEY_BINDINGS,
    "fire",
    "KeyE",
  );
  assert.equal(swapped.fire, "KeyE");
  assert.equal(swapped.power, "Space");
  assert.deepEqual(
    rebindGameAction(swapped, "power", "KeyP"),
    swapped,
  );
  assert.deepEqual(
    rebindGameAction(swapped, "power", "ArrowUp"),
    swapped,
  );
  assert.deepEqual(
    sanitizeGamePreferences({
      keyBindings: {
        ...DEFAULT_GAME_KEY_BINDINGS,
        fire: "KeyF",
        power: "KeyF",
      },
    }).keyBindings,
    DEFAULT_GAME_KEY_BINDINGS,
  );
});

test("preference storage fails soft when browser persistence is blocked", () => {
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.deepEqual(
    loadGamePreferences(blocked),
    sanitizeGamePreferences(null),
  );
  assert.equal(
    saveGamePreferences(blocked, sanitizeGamePreferences(null)),
    false,
  );
});
