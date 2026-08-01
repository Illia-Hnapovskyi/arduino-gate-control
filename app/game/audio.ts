import type { SectorId } from "./types";

export type TrackId =
  | "space"
  | "neon"
  | "boss"
  | "joy"
  | "elise"
  | "bells"
  | "anthem";

export type PlayerState = "playing" | "paused" | "stopped";

export type ChiptuneTrack = {
  id: TrackId;
  bpm: number;
  notes: readonly number[];
  bassRoots: readonly number[];
  sustainedSteps?: readonly number[];
  stepMultiplier?: number;
};

export const GAME_SFX_IDS = [
  "SHOT",
  "SCORE",
  "CRASH",
  "OVER",
  "POWER",
  "SHIELD",
  "BOSS",
  "WARN",
  "ACH",
  "LASER",
  "MISSILE",
  "EMP",
  "RECORD",
  "LOW",
  "MENU",
] as const;

export type GameSfxId = (typeof GAME_SFX_IDS)[number];
export type GameSfxCommand = `SFX:${GameSfxId}`;

export type SectorAudioId = SectorId;

export type SectorAudioProfile = {
  trackId: TrackId;
  tempoMultiplier: number;
  accentEvery: 2 | 4 | 8;
  leadWave: OscillatorType;
  bassWave: OscillatorType;
  leadGain: number;
  bassGain: number;
};

type WebAudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

type BrowserToneCue = {
  frequency: number;
  offset: number;
  duration: number;
  type: OscillatorType;
  gain: number;
};

export type BrowserSfxOptions = {
  destination?: AudioNode;
  startsAt?: number;
  volumePercent?: number;
};

export type BrowserAudioEngine = {
  ensureContext: () => AudioContext | null;
  resume: () => Promise<boolean>;
  playEffect: (effect: GameSfxId, volumePercent?: number) => boolean;
  close: () => Promise<void>;
};

// Original E-minor chiptune lead. Four phrases make a longer, less repetitive
// loop while remaining light enough for mobile browsers.
const SPACE_CHASE_NOTES = [
  659, 784, 988, 1319, 0, 988, 784, 659,
  587, 740, 880, 1175, 0, 880, 740, 587,
  523, 659, 784, 1047, 0, 1047, 1175, 1319,
  494, 622, 740, 988, 0, 1245, 988, 740,
  659, 988, 1319, 1568, 1319, 988, 784, 659,
  587, 880, 1175, 1480, 1175, 880, 740, 587,
  523, 784, 1047, 1319, 1568, 1319, 1047, 784,
  494, 740, 988, 1245, 0, 988, 1175, 1319,
] as const;

const SPACE_CHASE_BASS = [
  165, 165, 147, 147,
  131, 131, 123, 123,
  165, 165, 147, 147,
  131, 131, 123, 165,
] as const;

const NEON_FLIGHT_NOTES = [
  523, 659, 784, 1047, 784, 659, 523, 0,
  587, 740, 880, 1175, 880, 740, 587, 0,
  659, 784, 988, 1319, 988, 784, 659, 0,
  784, 988, 1175, 1568, 1175, 988, 784, 0,
  1047, 988, 784, 659, 784, 988, 1047, 1319,
  1175, 988, 880, 740, 880, 988, 1175, 1480,
  1319, 1175, 988, 784, 659, 784, 988, 1175,
  1047, 784, 659, 523, 0, 659, 784, 1047,
] as const;

const NEON_FLIGHT_BASS = [
  131, 147, 165, 196,
  131, 147, 165, 196,
  175, 147, 131, 165,
  175, 147, 131, 196,
] as const;

const BOSS_ALERT_NOTES = [
  220, 0, 220, 330, 440, 0, 392, 330,
  196, 0, 196, 294, 392, 0, 349, 294,
  175, 0, 262, 349, 523, 0, 440, 349,
  196, 294, 392, 587, 0, 523, 392, 294,
  220, 330, 440, 659, 440, 330, 220, 0,
  247, 370, 494, 740, 494, 370, 247, 0,
  262, 392, 523, 784, 698, 523, 392, 262,
  247, 370, 494, 740, 0, 587, 494, 330,
] as const;

const BOSS_ALERT_BASS = [
  110, 110, 98, 98,
  87, 87, 98, 98,
  110, 110, 123, 123,
  131, 131, 123, 110,
] as const;

const ODE_TO_JOY_NOTES = [
  659, 659, 698, 784, 784, 698, 659, 587,
  523, 523, 587, 659, 659, 587, 587, 0,
  659, 659, 698, 784, 784, 698, 659, 587,
  523, 523, 587, 659, 587, 523, 523, 0,
  587, 587, 659, 523, 587, 659, 698, 659,
  523, 587, 659, 698, 659, 523, 587, 659,
  698, 659, 587, 523, 587, 659, 523, 587,
  659, 698, 659, 587, 523, 523, 0, 0,
] as const;

const ODE_TO_JOY_BASS = [
  131, 131, 98, 98,
  131, 131, 98, 131,
] as const;

// Familiar public-domain melodies give the small buzzer more variety while
// keeping the player fully browser-streamed: no new Arduino firmware needed.
const FUR_ELISE_NOTES = [
  659, 622, 659, 622, 659, 494, 587, 523,
  440, 0, 262, 330, 440, 0, 494, 330,
  415, 0, 494, 523, 0, 659, 622, 659,
  622, 659, 494, 587, 523, 440, 0, 262,
  330, 440, 0, 494, 330, 523, 494, 440,
  0, 494, 523, 587, 659, 0, 698, 659,
  587, 523, 0, 659, 587, 523, 494, 0,
  523, 587, 659, 698, 0, 784, 698, 659,
  587, 0, 698, 659, 587, 523, 0, 659,
  523, 494, 440, 0, 494, 523, 587, 659,
  698, 784, 698, 659, 587, 523, 494, 440,
] as const;

const FUR_ELISE_BASS = [
  110, 110, 131, 131,
  110, 110, 98, 98,
  110, 110, 131, 147,
  110, 98, 110, 131,
] as const;

const CAROL_OF_BELLS_NOTES = [
  659, 622, 659, 622, 659, 622, 659, 622,
  659, 622, 659, 622, 659, 622, 659, 622,
  659, 622, 659, 622, 659, 622, 659, 622,
  784, 740, 698, 659, 622, 659, 740, 698,
  659, 622, 659, 622, 659, 622, 659, 622,
  784, 740, 698, 659, 622, 659, 740, 698,
  659, 622, 659, 622, 659, 622, 659, 622,
  784, 740, 698, 659, 622, 659, 740, 698,
  831, 784, 740, 698, 659, 698, 740, 784,
  831, 784, 740, 698, 659, 622, 659, 0,
  659, 622, 659, 622, 659, 622, 659, 622,
  784, 740, 698, 659, 622, 659, 740, 698,
] as const;

const CAROL_OF_BELLS_BASS = [
  165, 165, 147, 147,
  131, 131, 147, 165,
  165, 147, 131, 147,
] as const;

// "Shche ne vmerla Ukrainy" — an 8-bit lead arrangement of the State Anthem.
const UKRAINE_ANTHEM_NOTES = [
  294, 294, 330, 370, 392, 392, 370, 330,
  294, 330, 370, 392, 440, 440, 392, 370,
  330, 330, 370, 392, 440, 494, 440, 392,
  370, 330, 294, 330, 370, 392, 294, 0,
  440, 440, 494, 523, 494, 440, 392, 370,
  440, 494, 523, 587, 523, 494, 440, 392,
  370, 392, 440, 494, 523, 494, 440, 392,
  370, 330, 294, 330, 294, 0, 0, 0,
  294, 330, 370, 392, 440, 392, 370, 330,
  294, 330, 370, 440, 494, 440, 392, 370,
  330, 370, 392, 440, 494, 523, 494, 440,
  392, 370, 330, 294, 330, 370, 294, 0,
  440, 494, 523, 587, 659, 587, 523, 494,
  440, 392, 440, 494, 523, 494, 440, 392,
  370, 330, 294, 330, 370, 392, 370, 330,
  294, 330, 294, 0, 0, 0, 0, 0,
] as const;

const UKRAINE_ANTHEM_BASS = [
  147, 147, 165, 185,
  196, 196, 185, 165,
  147, 165, 185, 196,
  220, 196, 185, 147,
] as const;

export const CHIPTUNE_TRACKS = [
  {
    id: "space",
    bpm: 156,
    notes: SPACE_CHASE_NOTES,
    bassRoots: SPACE_CHASE_BASS,
  },
  {
    id: "neon",
    bpm: 168,
    notes: NEON_FLIGHT_NOTES,
    bassRoots: NEON_FLIGHT_BASS,
  },
  {
    id: "boss",
    bpm: 142,
    notes: BOSS_ALERT_NOTES,
    bassRoots: BOSS_ALERT_BASS,
  },
  {
    id: "joy",
    bpm: 124,
    notes: ODE_TO_JOY_NOTES,
    bassRoots: ODE_TO_JOY_BASS,
    sustainedSteps: [14, 15, 30, 31, 46, 63],
    stepMultiplier: 1.7,
  },
  {
    id: "elise",
    bpm: 128,
    notes: FUR_ELISE_NOTES,
    bassRoots: FUR_ELISE_BASS,
    sustainedSteps: [8, 16, 20, 39, 72, 95],
    stepMultiplier: 1.6,
  },
  {
    id: "bells",
    bpm: 152,
    notes: CAROL_OF_BELLS_NOTES,
    bassRoots: CAROL_OF_BELLS_BASS,
    sustainedSteps: [31, 47, 63, 79, 95],
    stepMultiplier: 1.45,
  },
  {
    id: "anthem",
    bpm: 102,
    notes: UKRAINE_ANTHEM_NOTES,
    bassRoots: UKRAINE_ANTHEM_BASS,
    sustainedSteps: [15, 31, 47, 63, 79, 95, 120, 127],
    stepMultiplier: 1.7,
  },
] as const satisfies readonly ChiptuneTrack[];

export const SECTOR_AUDIO = {
  starfield: {
    trackId: "space",
    tempoMultiplier: 1,
    accentEvery: 4,
    leadWave: "square",
    bassWave: "triangle",
    leadGain: 0.11,
    bassGain: 0.16,
  },
  nebula: {
    trackId: "joy",
    tempoMultiplier: 0.84,
    accentEvery: 8,
    leadWave: "sine",
    bassWave: "triangle",
    leadGain: 0.1,
    bassGain: 0.13,
  },
  "meteor-belt": {
    trackId: "boss",
    tempoMultiplier: 1.08,
    accentEvery: 2,
    leadWave: "square",
    bassWave: "sawtooth",
    leadGain: 0.1,
    bassGain: 0.12,
  },
  ice: {
    trackId: "elise",
    tempoMultiplier: 0.82,
    accentEvery: 8,
    leadWave: "sine",
    bassWave: "triangle",
    leadGain: 0.09,
    bassGain: 0.12,
  },
  "ion-storm": {
    trackId: "neon",
    tempoMultiplier: 1.12,
    accentEvery: 2,
    leadWave: "sawtooth",
    bassWave: "square",
    leadGain: 0.08,
    bassGain: 0.1,
  },
  "ship-graveyard": {
    trackId: "bells",
    tempoMultiplier: 0.92,
    accentEvery: 4,
    leadWave: "triangle",
    bassWave: "sine",
    leadGain: 0.1,
    bassGain: 0.13,
  },
  solar: {
    trackId: "anthem",
    tempoMultiplier: 1.06,
    accentEvery: 4,
    leadWave: "square",
    bassWave: "sawtooth",
    leadGain: 0.1,
    bassGain: 0.11,
  },
  dark: {
    trackId: "space",
    tempoMultiplier: 0.72,
    accentEvery: 8,
    leadWave: "triangle",
    bassWave: "sine",
    leadGain: 0.075,
    bassGain: 0.11,
  },
  boss: {
    trackId: "boss",
    tempoMultiplier: 1.18,
    accentEvery: 2,
    leadWave: "square",
    bassWave: "sawtooth",
    leadGain: 0.11,
    bassGain: 0.15,
  },
} as const satisfies Record<SectorAudioId, SectorAudioProfile>;

const BROWSER_SFX_PATTERNS = {
  SHOT: [
    { frequency: 1568, offset: 0, duration: 0.055, type: "square", gain: 0.07 },
  ],
  SCORE: [
    { frequency: 988, offset: 0, duration: 0.08, type: "square", gain: 0.075 },
    { frequency: 1568, offset: 0.075, duration: 0.11, type: "square", gain: 0.075 },
  ],
  CRASH: [
    { frequency: 110, offset: 0, duration: 0.22, type: "sawtooth", gain: 0.09 },
  ],
  OVER: [
    { frequency: 330, offset: 0, duration: 0.16, type: "square", gain: 0.065 },
    { frequency: 247, offset: 0.13, duration: 0.16, type: "square", gain: 0.065 },
    { frequency: 196, offset: 0.26, duration: 0.16, type: "square", gain: 0.065 },
    { frequency: 123, offset: 0.39, duration: 0.16, type: "square", gain: 0.065 },
  ],
  POWER: [
    { frequency: 523, offset: 0, duration: 0.07, type: "square", gain: 0.065 },
    { frequency: 784, offset: 0.065, duration: 0.08, type: "square", gain: 0.07 },
    { frequency: 1175, offset: 0.135, duration: 0.12, type: "square", gain: 0.075 },
  ],
  SHIELD: [
    { frequency: 392, offset: 0, duration: 0.18, type: "sine", gain: 0.08 },
    { frequency: 784, offset: 0.035, duration: 0.22, type: "triangle", gain: 0.06 },
  ],
  BOSS: [
    { frequency: 110, offset: 0, duration: 0.17, type: "sawtooth", gain: 0.1 },
    { frequency: 110, offset: 0.25, duration: 0.17, type: "sawtooth", gain: 0.1 },
    { frequency: 165, offset: 0.5, duration: 0.24, type: "sawtooth", gain: 0.1 },
  ],
  WARN: [
    { frequency: 880, offset: 0, duration: 0.08, type: "square", gain: 0.08 },
    { frequency: 880, offset: 0.14, duration: 0.08, type: "square", gain: 0.08 },
    { frequency: 880, offset: 0.28, duration: 0.08, type: "square", gain: 0.08 },
  ],
  ACH: [
    { frequency: 659, offset: 0, duration: 0.09, type: "triangle", gain: 0.075 },
    { frequency: 988, offset: 0.075, duration: 0.1, type: "triangle", gain: 0.08 },
    { frequency: 1319, offset: 0.16, duration: 0.16, type: "triangle", gain: 0.085 },
  ],
  LASER: [
    { frequency: 1760, offset: 0, duration: 0.055, type: "sawtooth", gain: 0.07 },
    { frequency: 1175, offset: 0.045, duration: 0.09, type: "sawtooth", gain: 0.065 },
  ],
  MISSILE: [
    { frequency: 196, offset: 0, duration: 0.08, type: "square", gain: 0.075 },
    { frequency: 294, offset: 0.07, duration: 0.09, type: "square", gain: 0.075 },
    { frequency: 440, offset: 0.15, duration: 0.13, type: "sawtooth", gain: 0.08 },
  ],
  EMP: [
    { frequency: 740, offset: 0, duration: 0.08, type: "sawtooth", gain: 0.075 },
    { frequency: 370, offset: 0.065, duration: 0.12, type: "sawtooth", gain: 0.075 },
    { frequency: 110, offset: 0.16, duration: 0.2, type: "sine", gain: 0.09 },
  ],
  RECORD: [
    { frequency: 784, offset: 0, duration: 0.09, type: "square", gain: 0.075 },
    { frequency: 988, offset: 0.08, duration: 0.09, type: "square", gain: 0.075 },
    { frequency: 1319, offset: 0.16, duration: 0.11, type: "square", gain: 0.08 },
    { frequency: 1568, offset: 0.26, duration: 0.2, type: "triangle", gain: 0.085 },
  ],
  LOW: [
    { frequency: 196, offset: 0, duration: 0.09, type: "square", gain: 0.07 },
    { frequency: 196, offset: 0.24, duration: 0.09, type: "square", gain: 0.07 },
  ],
  MENU: [
    { frequency: 659, offset: 0, duration: 0.045, type: "triangle", gain: 0.055 },
    { frequency: 988, offset: 0.04, duration: 0.065, type: "triangle", gain: 0.06 },
  ],
} as const satisfies Record<GameSfxId, readonly BrowserToneCue[]>;

export function getTrack(trackId: TrackId): ChiptuneTrack {
  return (
    CHIPTUNE_TRACKS.find((track) => track.id === trackId) ??
    CHIPTUNE_TRACKS[0]
  );
}

export function isGameSfxId(value: string): value is GameSfxId {
  return (GAME_SFX_IDS as readonly string[]).includes(value);
}

export function gameSfxCommand(effect: GameSfxId): GameSfxCommand {
  return `SFX:${effect}`;
}

export function getTrackStepSeconds(track: ChiptuneTrack, step: number) {
  const baseStepSeconds =
    (60 / track.bpm / 2) * (track.stepMultiplier ?? 1);
  if (track.notes[step] === 0) return baseStepSeconds * 0.55;
  return track.sustainedSteps?.includes(step)
    ? baseStepSeconds * 1.9
    : baseStepSeconds;
}

export function getSectorAudio(sector: SectorAudioId | string) {
  return SECTOR_AUDIO[sector as SectorAudioId] ?? SECTOR_AUDIO.starfield;
}

export function scheduleBrowserTone(
  context: AudioContext,
  destination: AudioNode,
  frequency: number,
  startsAt: number,
  duration: number,
  type: OscillatorType,
  volume: number,
) {
  if (frequency <= 0) return;

  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, startsAt);
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(volume, startsAt + 0.008);
  gain.gain.exponentialRampToValueAtTime(
    0.0001,
    startsAt + Math.max(0.025, duration),
  );
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration + 0.025);
}

export function scheduleBrowserTrackStep(
  context: AudioContext,
  destination: AudioNode,
  track: ChiptuneTrack,
  stepIndex: number,
  startsAt: number,
  profile: SectorAudioProfile = SECTOR_AUDIO.starfield,
) {
  const step = stepIndex % track.notes.length;
  const stepSeconds =
    getTrackStepSeconds(track, step) / profile.tempoMultiplier;

  scheduleBrowserTone(
    context,
    destination,
    track.notes[step],
    startsAt,
    stepSeconds * 0.82,
    profile.leadWave,
    profile.leadGain,
  );

  const beatInAccent = step % profile.accentEvery;
  if (beatInAccent === 0 || beatInAccent === profile.accentEvery / 2) {
    const root =
      track.bassRoots[Math.floor(step / 4) % track.bassRoots.length];
    const isDownbeat = beatInAccent === 0;
    scheduleBrowserTone(
      context,
      destination,
      isDownbeat ? root : root * 2,
      startsAt,
      stepSeconds * (isDownbeat ? 1.75 : 0.72),
      profile.bassWave,
      profile.bassGain * (isDownbeat ? 1 : 0.62),
    );
  }

  return stepSeconds;
}

export function playBrowserGameSfx(
  context: AudioContext,
  effect: GameSfxId,
  options: BrowserSfxOptions = {},
) {
  const volumePercent = Math.max(
    0,
    Math.min(100, options.volumePercent ?? 28),
  );
  if (volumePercent === 0) return 0;

  const startsAt = options.startsAt ?? context.currentTime + 0.005;
  const destination = options.destination ?? context.destination;
  const volumeScale = volumePercent / 28;
  let endsAt = startsAt;

  for (const cue of BROWSER_SFX_PATTERNS[effect]) {
    scheduleBrowserTone(
      context,
      destination,
      cue.frequency,
      startsAt + cue.offset,
      cue.duration,
      cue.type,
      Math.min(0.35, cue.gain * volumeScale),
    );
    endsAt = Math.max(endsAt, startsAt + cue.offset + cue.duration);
  }

  return endsAt;
}

export function createBrowserAudioEngine(): BrowserAudioEngine {
  let context: AudioContext | null = null;

  const ensureContext = () => {
    if (context) return context;
    if (typeof window === "undefined") return null;
    const AudioContextConstructor =
      window.AudioContext ||
      (window as WebAudioWindow).webkitAudioContext;
    if (!AudioContextConstructor) return null;
    context = new AudioContextConstructor();
    return context;
  };

  return {
    ensureContext,
    async resume() {
      const audioContext = ensureContext();
      if (!audioContext) return false;
      await audioContext.resume();
      return true;
    },
    playEffect(effect, volumePercent = 28) {
      const audioContext = ensureContext();
      if (!audioContext || volumePercent <= 0) return false;
      void audioContext.resume();
      playBrowserGameSfx(audioContext, effect, { volumePercent });
      return true;
    },
    async close() {
      const audioContext = context;
      context = null;
      if (audioContext && audioContext.state !== "closed") {
        await audioContext.close();
      }
    },
  };
}
