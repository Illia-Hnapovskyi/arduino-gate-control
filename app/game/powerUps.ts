import { MODE_BALANCE, POWER_UP_BALANCE, UPGRADE_BALANCE } from "./balance.ts";
import { combineSeed, createSeededRng } from "./rng.ts";
import type {
  GameModeId,
  PowerUpId,
  PowerUpRuntimeState,
  UpgradeCategory,
  UpgradeId,
  UpgradeStacks,
} from "./types.ts";

export type UpgradeChoiceOptions = {
  seed: number | string;
  wave: number;
  mode: GameModeId;
  owned?: UpgradeStacks;
  excluded?: readonly UpgradeId[];
  count?: number;
};

const CATEGORY_ORDER: readonly UpgradeCategory[] = [
  "weapon",
  "defense",
  "utility",
];

function validStackCount(stacks: UpgradeStacks, id: UpgradeId) {
  const value = stacks[id];
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value ?? 0) : 0;
}

/**
 * Returns a deterministic, unique offer. When three categories are available,
 * the default three-card offer contains one card from each category.
 */
export function selectUpgradeChoices({
  seed,
  wave,
  mode,
  owned = {},
  excluded = [],
  count = 3,
}: UpgradeChoiceOptions): UpgradeId[] {
  if (!Number.isSafeInteger(wave) || wave < 1) {
    throw new RangeError("Wave must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(count) || count < 0 || count > 3) {
    throw new RangeError("Upgrade choice count must be between zero and three.");
  }
  if (!MODE_BALANCE[mode].allowsUpgradeChoices || count === 0) return [];

  const blocked = new Set(excluded);
  const eligible = (Object.keys(UPGRADE_BALANCE) as UpgradeId[]).filter((id) => {
    const config = UPGRADE_BALANCE[id];
    return (
      !blocked.has(id) &&
      (config.compatibleModes as readonly GameModeId[]).includes(mode) &&
      validStackCount(owned, id) < config.maxStacks
    );
  });
  const rng = createSeededRng(combineSeed(seed, mode, wave, "upgrade-offer"));
  const choices: UpgradeId[] = [];

  const takeWeighted = (candidates: readonly UpgradeId[]) => {
    const remaining = candidates.filter((id) => !choices.includes(id));
    if (remaining.length === 0) return;
    const choice = rng.weightedPick(remaining, (id) => {
      const config = UPGRADE_BALANCE[id];
      return config.selectionWeight / (1 + validStackCount(owned, id));
    });
    choices.push(choice);
  };

  const categoryOffset = wave % CATEGORY_ORDER.length;
  const orderedCategories = [
    ...CATEGORY_ORDER.slice(categoryOffset),
    ...CATEGORY_ORDER.slice(0, categoryOffset),
  ];
  for (const category of orderedCategories) {
    if (choices.length >= count) break;
    takeWeighted(
      eligible.filter((id) => UPGRADE_BALANCE[id].category === category),
    );
  }
  while (choices.length < count) {
    const before = choices.length;
    takeWeighted(eligible);
    if (choices.length === before) break;
  }

  return choices;
}

export function addUpgradeStack(
  owned: UpgradeStacks,
  id: UpgradeId,
): UpgradeStacks {
  const config = UPGRADE_BALANCE[id];
  const current = validStackCount(owned, id);
  if (current >= config.maxStacks) return { ...owned };
  return { ...owned, [id]: current + 1 };
}

export function canActivatePowerUp(
  id: PowerUpId,
  nowMs: number,
  energy: number,
  previous: PowerUpRuntimeState | null,
) {
  const config = POWER_UP_BALANCE[id];
  return (
    Number.isFinite(nowMs) &&
    nowMs >= 0 &&
    Number.isFinite(energy) &&
    energy >= config.energyCost &&
    (!previous || previous.id !== id || nowMs >= previous.cooldownUntilMs)
  );
}

export function activatePowerUp(
  id: PowerUpId,
  nowMs: number,
  energy: number,
  previous: PowerUpRuntimeState | null = null,
): PowerUpRuntimeState | null {
  if (!canActivatePowerUp(id, nowMs, energy, previous)) return null;
  const config = POWER_UP_BALANCE[id];
  const activatedAtMs = Math.floor(nowMs);
  return {
    id,
    activatedAtMs,
    activeUntilMs: activatedAtMs + config.durationMs,
    cooldownUntilMs: activatedAtMs + config.cooldownMs,
  };
}

export function isPowerUpActive(state: PowerUpRuntimeState, nowMs: number) {
  return nowMs >= state.activatedAtMs && nowMs < state.activeUntilMs;
}

export function getPowerUpCooldownRemaining(
  state: PowerUpRuntimeState,
  nowMs: number,
) {
  return Math.max(0, Math.ceil(state.cooldownUntilMs - Math.max(0, nowMs)));
}
