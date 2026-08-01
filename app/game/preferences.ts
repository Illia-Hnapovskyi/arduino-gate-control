export const GAME_PREFERENCES_STORAGE_KEY =
  "arduino-gate-space-defender-preferences:v1";

export const GAME_ACTIONS = [
  "moveUp",
  "moveDown",
  "moveLeft",
  "moveRight",
  "fire",
  "power",
] as const;

export type GameAction = (typeof GAME_ACTIONS)[number];

export type GameKeyBindings = Record<GameAction, string>;

export type GamePreferences = {
  effectsVolume: number;
  invertArduinoY: boolean;
  musicVolume: number;
  reducedMotion: boolean;
  screenShake: boolean;
  keyBindings: GameKeyBindings;
};

export const DEFAULT_GAME_KEY_BINDINGS: GameKeyBindings = {
  moveUp: "KeyW",
  moveDown: "KeyS",
  moveLeft: "KeyA",
  moveRight: "KeyD",
  fire: "Space",
  power: "KeyE",
};

export const DEFAULT_GAME_PREFERENCES: GamePreferences = {
  effectsVolume: 28,
  invertArduinoY: true,
  musicVolume: 42,
  reducedMotion: false,
  screenShake: true,
  keyBindings: DEFAULT_GAME_KEY_BINDINGS,
};

const KEY_CODE_PATTERN = /^(?:Key[A-Z]|Digit[0-9]|Space|Enter|Shift(?:Left|Right)|Control(?:Left|Right))$/;

export function isGameKeyCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "KeyP" &&
    KEY_CODE_PATTERN.test(value)
  );
}

export function rebindGameAction(
  bindings: GameKeyBindings,
  action: GameAction,
  code: string,
): GameKeyBindings {
  if (!isGameKeyCode(code)) return { ...bindings };
  const previousCode = bindings[action];
  const conflictingAction = GAME_ACTIONS.find(
    (candidate) => candidate !== action && bindings[candidate] === code,
  );
  return {
    ...bindings,
    ...(conflictingAction ? { [conflictingAction]: previousCode } : {}),
    [action]: code,
  };
}

function clampPercent(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : fallback;
}

export function sanitizeGamePreferences(value: unknown): GamePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ...DEFAULT_GAME_PREFERENCES,
      keyBindings: { ...DEFAULT_GAME_KEY_BINDINGS },
    };
  }

  const candidate = value as Partial<GamePreferences>;
  const rawBindings =
    candidate.keyBindings && typeof candidate.keyBindings === "object"
      ? candidate.keyBindings
      : {};
  const keyBindings = GAME_ACTIONS.reduce<GameKeyBindings>((result, action) => {
    const code = (rawBindings as Partial<GameKeyBindings>)[action];
    result[action] = isGameKeyCode(code)
      ? code
      : DEFAULT_GAME_KEY_BINDINGS[action];
    return result;
  }, { ...DEFAULT_GAME_KEY_BINDINGS });
  const uniqueBindings =
    new Set(Object.values(keyBindings)).size === GAME_ACTIONS.length
      ? keyBindings
      : { ...DEFAULT_GAME_KEY_BINDINGS };

  return {
    effectsVolume: clampPercent(
      candidate.effectsVolume,
      DEFAULT_GAME_PREFERENCES.effectsVolume,
    ),
    invertArduinoY:
      typeof candidate.invertArduinoY === "boolean"
        ? candidate.invertArduinoY
        : DEFAULT_GAME_PREFERENCES.invertArduinoY,
    musicVolume: clampPercent(
      candidate.musicVolume,
      DEFAULT_GAME_PREFERENCES.musicVolume,
    ),
    reducedMotion:
      typeof candidate.reducedMotion === "boolean"
        ? candidate.reducedMotion
        : DEFAULT_GAME_PREFERENCES.reducedMotion,
    screenShake:
      typeof candidate.screenShake === "boolean"
        ? candidate.screenShake
        : DEFAULT_GAME_PREFERENCES.screenShake,
    keyBindings: uniqueBindings,
  };
}

export function loadGamePreferences(storage: Pick<Storage, "getItem">) {
  try {
    const raw = storage.getItem(GAME_PREFERENCES_STORAGE_KEY);
    return raw
      ? sanitizeGamePreferences(JSON.parse(raw) as unknown)
      : sanitizeGamePreferences(null);
  } catch {
    return sanitizeGamePreferences(null);
  }
}

export function saveGamePreferences(
  storage: Pick<Storage, "setItem">,
  preferences: GamePreferences,
) {
  try {
    storage.setItem(
      GAME_PREFERENCES_STORAGE_KEY,
      JSON.stringify(sanitizeGamePreferences(preferences)),
    );
    return true;
  } catch {
    return false;
  }
}

export function effectiveReducedMotion(
  preference: boolean,
  mediaQueryMatches: boolean,
) {
  return preference || mediaQueryMatches;
}
