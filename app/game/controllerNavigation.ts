export type NavigationDirection = "up" | "down" | "left" | "right";
export type ControllerAction = NavigationDirection | "activate" | "back" | "pause";

export type ControllerNavigationState = {
  screen: string;
  direction: NavigationDirection | null;
  nextMoveAt: number;
  pressed: boolean;
  pressStartedAt: number | null;
  backSent: boolean;
  lastTapAt: number | null;
  neutralRequired: boolean;
};

export function createControllerNavigationState(): ControllerNavigationState {
  return { screen: "", direction: null, nextMoveAt: 0, pressed: false, pressStartedAt: null, backSent: false, lastTapAt: null, neutralRequired: true };
}

/** The one-switch Arduino keeps fire/hold-power in combat. Two short clicks at
 * centre pause; in menus, release selects and a hold goes back exactly once. */
export function pollControllerNavigation(
  state: ControllerNavigationState,
  input: { active: boolean; screen: string; x: number; y: number; pressed: boolean; now: number },
): ControllerAction[] {
  const actions: ControllerAction[] = [];
  const centred = Math.abs(input.x) < 0.3 && Math.abs(input.y) < 0.3;
  if (!input.active || input.screen !== state.screen) {
    Object.assign(state, createControllerNavigationState(), { screen: input.screen, pressed: input.pressed });
  }
  if (!input.active) return actions;
  if (state.neutralRequired) {
    if (!input.pressed && centred) state.neutralRequired = false;
    state.pressed = input.pressed;
    return actions;
  }

  if (input.pressed && !state.pressed) {
    state.pressStartedAt = input.now;
    state.backSent = false;
  }
  if (input.screen !== "playing" && input.pressed && state.pressStartedAt !== null && !state.backSent && input.now - state.pressStartedAt >= 750) {
    actions.push("back");
    state.backSent = true;
  }
  if (!input.pressed && state.pressed && state.pressStartedAt !== null) {
    const duration = input.now - state.pressStartedAt;
    if (input.screen === "playing") {
      if (duration <= 250 && centred) {
        if (state.lastTapAt !== null && input.now - state.lastTapAt <= 350) {
          actions.push("pause");
          state.lastTapAt = null;
        } else state.lastTapAt = input.now;
      } else state.lastTapAt = null;
    } else if (!state.backSent) actions.push("activate");
    state.pressStartedAt = null;
  }
  state.pressed = input.pressed;
  if (input.screen === "playing") return actions;

  const threshold = state.direction ? 0.3 : 0.55;
  const direction = Math.max(Math.abs(input.x), Math.abs(input.y)) < threshold
    ? null
    : Math.abs(input.x) > Math.abs(input.y)
      ? input.x < 0 ? "left" : "right"
      : input.y < 0 ? "up" : "down";
  if (!direction) {
    state.direction = null;
  } else if (direction !== state.direction || input.now >= state.nextMoveAt) {
    actions.push(direction);
    state.nextMoveAt = input.now + (direction !== state.direction ? 420 : 160);
    state.direction = direction;
  }
  return actions;
}

export function nextFocusIndex(
  boxes: readonly { x: number; y: number }[],
  current: number,
  direction: NavigationDirection,
) {
  if (!boxes.length) return -1;
  if (current < 0 || current >= boxes.length) return 0;
  const origin = boxes[current];
  let best = -1;
  let bestDistance = Infinity;
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "left" || direction === "up" ? -1 : 1;
  boxes.forEach((box, index) => {
    const along = ((horizontal ? box.x : box.y) - (horizontal ? origin.x : origin.y)) * sign;
    const across = Math.abs((horizontal ? box.y : box.x) - (horizontal ? origin.y : origin.x));
    const distance = along + across * 3;
    if (index !== current && along > 3 && distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  // Linear fallback makes every control reachable even in uneven responsive grids.
  return best >= 0 ? best : (current + sign + boxes.length) % boxes.length;
}
