import assert from "node:assert/strict";
import test from "node:test";
import { createControllerNavigationState, nextFocusIndex, pollControllerNavigation } from "../app/game/controllerNavigation.ts";

function controller(screen = "menu") {
  const state = createControllerNavigationState();
  const frame = { active: true, screen, x: 0, y: 0, pressed: false, now: 0 };
  const poll = (updates) => pollControllerNavigation(state, Object.assign(frame, updates));
  poll({});
  return poll;
}

test("Arduino navigation has dead zone, hysteresis, initial delay and bounded repeat", () => {
  const poll = controller();
  assert.deepEqual(poll({ x: 0.5, now: 1 }), []);
  assert.deepEqual(poll({ x: 0.6, now: 2 }), ["right"]);
  assert.deepEqual(poll({ x: 0.45, now: 250 }), []);
  assert.deepEqual(poll({ now: 422 }), ["right"]);
  assert.deepEqual(poll({ now: 500 }), []);
  assert.deepEqual(poll({ now: 582 }), ["right"]);
  assert.deepEqual(poll({ x: 0, now: 600 }), []);
  assert.deepEqual(poll({ y: -0.8, now: 610 }), ["up"]);
});

test("short release activates once, hold backs once without a release click", () => {
  const poll = controller();
  assert.deepEqual(poll({ pressed: true, now: 10 }), []);
  assert.deepEqual(poll({ pressed: false, now: 100 }), ["activate"]);
  assert.deepEqual(poll({ now: 110 }), []);
  poll({ pressed: true, now: 200 });
  assert.deepEqual(poll({ now: 950 }), ["back"]);
  assert.deepEqual(poll({ now: 1400 }), []);
  assert.deepEqual(poll({ pressed: false, now: 1500 }), []);
});

test("held fire cannot activate an upgrade/result on a screen transition or reconnect", () => {
  const poll = controller("playing");
  poll({ pressed: true, now: 100 });
  assert.deepEqual(poll({ screen: "upgrade", now: 800 }), []);
  assert.deepEqual(poll({ now: 1600 }), []);
  assert.deepEqual(poll({ pressed: false, now: 1650 }), []);
  poll({ pressed: true, now: 1700 });
  assert.deepEqual(poll({ pressed: false, now: 1800 }), ["activate"]);
  poll({ active: false, pressed: true, now: 1900 });
  assert.deepEqual(poll({ active: true, pressed: false, now: 2000 }), []);
});

test("only two short centred combat clicks pause; long power and steering do not", () => {
  const poll = controller("playing");
  poll({ pressed: true, now: 50 });
  assert.deepEqual(poll({ pressed: false, now: 150 }), []);
  poll({ pressed: true, now: 250 });
  assert.deepEqual(poll({ pressed: false, now: 350 }), ["pause"]);
  poll({ pressed: true, now: 500 });
  assert.deepEqual(poll({ now: 1250 }), []);
  assert.deepEqual(poll({ pressed: false, now: 1350 }), []);
  poll({ pressed: true, x: 1, now: 1400 });
  assert.deepEqual(poll({ pressed: false, now: 1450 }), []);
  poll({ pressed: true, now: 1500 });
  assert.deepEqual(poll({ pressed: false, now: 1550 }), []);
});

test("spatial focus handles grids, single controls, missing focus and edge wrapping", () => {
  const boxes = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }];
  assert.equal(nextFocusIndex(boxes, 0, "right"), 1);
  assert.equal(nextFocusIndex(boxes, 0, "down"), 2);
  assert.equal(nextFocusIndex(boxes, 3, "right"), 0);
  assert.equal(nextFocusIndex(boxes, -1, "up"), 0);
  assert.equal(nextFocusIndex([boxes[0]], 0, "right"), 0);
  assert.equal(nextFocusIndex([], 0, "right"), -1);
});
