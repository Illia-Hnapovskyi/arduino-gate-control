import type { GameKeyBindings } from "./preferences";
import type { RunController } from "./types";

export const JOYSTICK_DEAD_ZONE = 90;

export type AnalogPoint = { x: number; y: number };

export type GameInputFrame = {
  controller?: RunController;
  fire: boolean;
  moveX: number;
  moveY: number;
  power: boolean;
};

export type ResolveGameInputOptions = {
  centre: AnalogPoint;
  invertY: boolean;
  joystick: AnalogPoint & { connected: boolean; pressed: boolean };
  keys: ReadonlySet<string>;
  keyBindings: GameKeyBindings;
  touch: ReadonlySet<string>;
  virtualJoystick: AnalogPoint & { active: boolean };
};

export function normalizeJoystickAxis(
  value: number,
  centre: number,
  deadZone = JOYSTICK_DEAD_ZONE,
) {
  const safeValue = Math.max(0, Math.min(1023, Number.isFinite(value) ? value : 512));
  const safeCentre = Math.max(1, Math.min(1022, Number.isFinite(centre) ? centre : 512));
  const difference = safeValue - safeCentre;
  if (Math.abs(difference) <= deadZone) return 0;
  const available = difference > 0 ? 1023 - safeCentre : safeCentre;
  const adjustedRange = Math.max(1, available - deadZone);
  return Math.sign(difference) * Math.min(1, (Math.abs(difference) - deadZone) / adjustedRange);
}

function digitalAxis(negative: boolean, positive: boolean) {
  return (positive ? 1 : 0) - (negative ? 1 : 0);
}

export function resolveGameInput({
  centre,
  invertY,
  joystick,
  keys,
  keyBindings,
  touch,
  virtualJoystick,
}: ResolveGameInputOptions): GameInputFrame {
  const keyboardX = digitalAxis(
    keys.has(keyBindings.moveLeft) || keys.has("ArrowLeft"),
    keys.has(keyBindings.moveRight) || keys.has("ArrowRight"),
  );
  const keyboardY = digitalAxis(
    keys.has(keyBindings.moveUp) || keys.has("ArrowUp"),
    keys.has(keyBindings.moveDown) || keys.has("ArrowDown"),
  );
  const touchX = digitalAxis(touch.has("left"), touch.has("right"));
  const touchY = digitalAxis(touch.has("up"), touch.has("down"));
  const physicalX = joystick.connected
    ? normalizeJoystickAxis(joystick.x, centre.x)
    : 0;
  const rawPhysicalY = joystick.connected
    ? normalizeJoystickAxis(joystick.y, centre.y)
    : 0;
  const physicalY = invertY ? rawPhysicalY : -rawPhysicalY;
  const analogX = virtualJoystick.active ? virtualJoystick.x : physicalX;
  const analogY = virtualJoystick.active ? virtualJoystick.y : physicalY;
  const keyboardActive =
    keyboardX !== 0 ||
    keyboardY !== 0 ||
    keys.has(keyBindings.fire) ||
    keys.has(keyBindings.power);
  const touchActive =
    touchX !== 0 ||
    touchY !== 0 ||
    touch.has("fire") ||
    touch.has("power") ||
    virtualJoystick.active;
  const arduinoActive =
    joystick.connected &&
    (physicalX !== 0 || physicalY !== 0 || joystick.pressed);
  const activeKinds = [keyboardActive, touchActive, arduinoActive].filter(Boolean).length;

  const controller: RunController | undefined =
    activeKinds === 0
      ? undefined
      : activeKinds > 1
        ? "mixed"
        : arduinoActive
          ? "arduino"
          : touchActive
            ? "touch"
            : "keyboard";

  return {
    ...(controller ? { controller } : {}),
    fire:
      joystick.pressed || keys.has(keyBindings.fire) || touch.has("fire"),
    moveX: Math.max(-1, Math.min(1, analogX + keyboardX + touchX)),
    moveY: Math.max(-1, Math.min(1, analogY + keyboardY + touchY)),
    power: keys.has(keyBindings.power) || touch.has("power"),
  };
}

export function isNativeKeyboardControl(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "button, input, select, textarea, a[href], [contenteditable='true']",
      ),
    )
  );
}
