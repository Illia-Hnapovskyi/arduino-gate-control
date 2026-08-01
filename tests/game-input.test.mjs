import assert from "node:assert/strict";
import test from "node:test";

import { resolveGameInput } from "../app/game/input.ts";
import { DEFAULT_GAME_KEY_BINDINGS } from "../app/game/preferences.ts";

const base = {
  centre: { x: 512, y: 512 },
  invertY: true,
  joystick: { connected: false, pressed: false, x: 512, y: 512 },
  keys: new Set(),
  keyBindings: DEFAULT_GAME_KEY_BINDINGS,
  touch: new Set(),
  virtualJoystick: { active: false, x: 0, y: 0 },
};

test("idle input does not claim a keyboard controller", () => {
  const frame = resolveGameInput(base);

  assert.equal(frame.controller, undefined);
  assert.equal(frame.fire, false);
  assert.equal(frame.power, false);
  assert.equal(frame.moveX, 0);
  assert.equal(frame.moveY, 0);
});

test("input resolver combines keyboard, touch, and Arduino without exceeding unit range", () => {
  const frame = resolveGameInput({
    ...base,
    joystick: { connected: true, pressed: true, x: 1023, y: 512 },
    keys: new Set(["KeyD", "KeyE"]),
    touch: new Set(["down"]),
  });

  assert.equal(frame.controller, "mixed");
  assert.equal(frame.moveX, 1);
  assert.equal(frame.moveY, 1);
  assert.equal(frame.fire, true);
  assert.equal(frame.power, true);
});

test("virtual joystick overrides physical axes while keeping digital controls", () => {
  const frame = resolveGameInput({
    ...base,
    joystick: { connected: true, pressed: false, x: 0, y: 0 },
    keys: new Set(["KeyA"]),
    virtualJoystick: { active: true, x: 0.75, y: -0.4 },
  });

  assert.equal(frame.moveX, -0.25);
  assert.equal(frame.moveY, -0.4);
  assert.equal(frame.controller, "mixed");
});
