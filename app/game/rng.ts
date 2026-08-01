export type SeedInput = number | string;

export type SeededValue = {
  state: number;
  value: number;
};

export type SeededRng = {
  next: () => number;
  integer: (minimum: number, maximum: number) => number;
  chance: (probability: number) => boolean;
  pick: <T>(items: readonly T[]) => T;
  weightedPick: <T>(
    items: readonly T[],
    weightFor: (item: T) => number,
  ) => T;
  shuffle: <T>(items: readonly T[]) => T[];
  state: () => number;
};

function mix32(value: number) {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

export function hashSeed(seed: SeedInput) {
  if (typeof seed === "number") {
    if (!Number.isFinite(seed)) throw new TypeError("Seed must be finite.");
    return mix32(Math.trunc(seed));
  }

  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return mix32(hash);
}

export function combineSeed(seed: SeedInput, ...parts: readonly SeedInput[]) {
  let combined = hashSeed(seed);
  for (const part of parts) {
    combined = mix32(combined ^ hashSeed(part));
  }
  return combined;
}

/** Immutable Mulberry32 step, useful in reducers and deterministic tests. */
export function nextSeededValue(state: number): SeededValue {
  const nextState = (state + 0x6d2b79f5) >>> 0;
  let value = nextState;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return {
    state: nextState,
    value: ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296,
  };
}

export function createSeededRng(seed: SeedInput): SeededRng {
  let currentState = hashSeed(seed);

  const next = () => {
    const result = nextSeededValue(currentState);
    currentState = result.state;
    return result.value;
  };

  const integer = (minimum: number, maximum: number) => {
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)) {
      throw new TypeError("Random integer bounds must be safe integers.");
    }
    if (maximum < minimum) {
      throw new RangeError("Random integer maximum must not be below minimum.");
    }
    return minimum + Math.floor(next() * (maximum - minimum + 1));
  };

  const pick = <T>(items: readonly T[]) => {
    if (items.length === 0) throw new RangeError("Cannot pick from an empty list.");
    return items[integer(0, items.length - 1)] as T;
  };

  const weightedPick = <T>(
    items: readonly T[],
    weightFor: (item: T) => number,
  ) => {
    if (items.length === 0) {
      throw new RangeError("Cannot pick from an empty weighted list.");
    }
    const weights = items.map((item) => Math.max(0, weightFor(item)));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (!Number.isFinite(total) || total <= 0) {
      throw new RangeError("Weighted list must contain a positive finite weight.");
    }

    let cursor = next() * total;
    for (let index = 0; index < items.length; index++) {
      cursor -= weights[index] ?? 0;
      if (cursor < 0) return items[index] as T;
    }
    return items[items.length - 1] as T;
  };

  const shuffle = <T>(items: readonly T[]) => {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index--) {
      const target = integer(0, index);
      [result[index], result[target]] = [result[target] as T, result[index] as T];
    }
    return result;
  };

  return {
    next,
    integer,
    chance: (probability) => next() < Math.min(1, Math.max(0, probability)),
    pick,
    weightedPick,
    shuffle,
    state: () => currentState,
  };
}
