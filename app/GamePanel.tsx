"use client";

/* eslint-disable react-hooks/immutability -- the canvas physics loop intentionally
   keeps mutable simulation objects in refs so it can run without 60 React renders/s */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { generateRunId } from "../shared/gameStats";
import { GAME_COPY, type Language } from "./i18n";
import { PlayerStatsPanel } from "./PlayerStatsPanel";
import { useGameStats } from "./useGameStats";

type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "demo";

type GameStatus = "ready" | "playing" | "paused" | "over";
type TrackId =
  | "space"
  | "neon"
  | "boss"
  | "joy"
  | "elise"
  | "bells"
  | "anthem";
type PlayerState = "playing" | "paused" | "stopped";

type ChiptuneTrack = {
  id: TrackId;
  bpm: number;
  notes: readonly number[];
  bassRoots: readonly number[];
  sustainedSteps?: readonly number[];
  stepMultiplier?: number;
};

type VirtualJoystickState = {
  x: number;
  y: number;
  active: boolean;
};

type VirtualJoystickPointer = {
  pointerId: number;
  startX: number;
  startY: number;
  startedOnKnob: boolean;
} | null;

type WebAudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

type Bullet = {
  x: number;
  y: number;
  speed: number;
};

type Asteroid = {
  x: number;
  y: number;
  radius: number;
  speed: number;
  drift: number;
  spin: number;
  rotation: number;
  health: number;
};

type Star = {
  x: number;
  y: number;
  size: number;
  speed: number;
  alpha: number;
};

type GameWorld = {
  shipX: number;
  shipY: number;
  bullets: Bullet[];
  asteroids: Asteroid[];
  stars: Star[];
  lastFrame: number;
  lastShot: number;
  lastSpawn: number;
  elapsed: number;
  score: number;
  lives: number;
  level: number;
};

type GamePanelProps = {
  connection: ConnectionState;
  error: string;
  isSupported: boolean;
  language: Language;
  joystickPressed: boolean;
  joystickX: number;
  joystickY: number;
  onCommand: (command: string) => void;
  onConnect: () => void;
  onStartDemo: () => void;
};

const GAME_WIDTH = 900;
const GAME_HEIGHT = 540;
const SHIP_RADIUS = 21;
const DEAD_ZONE = 90;

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

const CHIPTUNE_TRACKS = [
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

function getTrack(trackId: TrackId): ChiptuneTrack {
  return (
    CHIPTUNE_TRACKS.find((track) => track.id === trackId) ??
    CHIPTUNE_TRACKS[0]
  );
}

function getTrackStepSeconds(track: ChiptuneTrack, step: number) {
  const baseStepSeconds =
    (60 / track.bpm / 2) * (track.stepMultiplier ?? 1);
  if (track.notes[step] === 0) return baseStepSeconds * 0.55;
  return track.sustainedSteps?.includes(step)
    ? baseStepSeconds * 1.9
    : baseStepSeconds;
}

function scheduleBrowserTone(
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

function createStars(): Star[] {
  return Array.from({ length: 90 }, () => ({
    x: Math.random() * GAME_WIDTH,
    y: Math.random() * GAME_HEIGHT,
    size: 0.7 + Math.random() * 2.2,
    speed: 18 + Math.random() * 58,
    alpha: 0.28 + Math.random() * 0.72,
  }));
}

function createWorld(): GameWorld {
  return {
    shipX: GAME_WIDTH / 2,
    shipY: GAME_HEIGHT - 70,
    bullets: [],
    asteroids: [],
    stars: createStars(),
    lastFrame: performance.now(),
    lastShot: 0,
    lastSpawn: 0,
    elapsed: 0,
    score: 0,
    lives: 3,
    level: 1,
  };
}

function normalizeAxis(value: number, center: number) {
  const difference = value - center;
  if (Math.abs(difference) <= DEAD_ZONE) return 0;

  const availableRange =
    difference > 0 ? Math.max(1, 1023 - center) : Math.max(1, center);
  const adjusted = Math.abs(difference) - DEAD_ZONE;
  const adjustedRange = Math.max(1, availableRange - DEAD_ZONE);
  return Math.sign(difference) * Math.min(1, adjusted / adjustedRange);
}

function circlesTouch(
  x1: number,
  y1: number,
  radius1: number,
  x2: number,
  y2: number,
  radius2: number,
) {
  const dx = x1 - x2;
  const dy = y1 - y2;
  const distance = radius1 + radius2;
  return dx * dx + dy * dy <= distance * distance;
}

function isNativeKeyboardControl(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "button, input, select, textarea, a[href], [contenteditable='true']",
      ),
    )
  );
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

export default function GamePanel({
  connection,
  error,
  isSupported,
  language,
  joystickPressed,
  joystickX,
  joystickY,
  onCommand,
  onConnect,
  onStartDemo,
}: GamePanelProps) {
  const copy = GAME_COPY[language];
  const gameStats = useGameStats({ language });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const [initialWorld] = useState(createWorld);
  const worldRef = useRef<GameWorld>(initialWorld);
  const statusRef = useRef<GameStatus>("ready");
  const joystickRef = useRef({ x: joystickX, y: joystickY, pressed: false });
  const centerRef = useRef({ x: 512, y: 512 });
  const invertYRef = useRef(true);
  const soundRef = useRef(true);
  const effectsVolumeRef = useRef(28);
  const keyboardRef = useRef(new Set<string>());
  const touchRef = useRef(new Set<string>());
  const virtualJoystickRef = useRef<VirtualJoystickState>({
    x: 0,
    y: 0,
    active: false,
  });
  const virtualJoystickPointerRef = useRef<VirtualJoystickPointer>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const musicBusRef = useRef<GainNode | null>(null);
  const musicTimerRef = useRef<number | null>(null);
  const musicStepRef = useRef(0);
  const musicNextTimeRef = useRef(0);
  const serialMusicTimerRef = useRef<number | null>(null);
  const serialMusicStepRef = useRef(0);
  const selectedTrackRef = useRef<TrackId>("space");
  const playerStateRef = useRef<PlayerState>("stopped");
  const resumeMusicAfterGamePauseRef = useRef(false);
  const previousPressRef = useRef(false);
  const commandRef = useRef(onCommand);
  const recordRunRef = useRef(gameStats.recordRun);
  const activeRunIdRef = useRef<string | null>(null);

  const [status, setStatus] = useState<GameStatus>("ready");
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [level, setLevel] = useState(1);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [effectsVolume, setEffectsVolume] = useState(28);
  const [selectedTrackId, setSelectedTrackId] =
    useState<TrackId>("space");
  const [playerState, setPlayerState] =
    useState<PlayerState>("stopped");
  const [trackStep, setTrackStep] = useState(0);
  const [invertY, setInvertY] = useState(true);
  const [center, setCenter] = useState({ x: 512, y: 512 });
  const [virtualJoystick, setVirtualJoystick] =
    useState<VirtualJoystickState>({
      x: 0,
      y: 0,
      active: false,
    });

  useEffect(() => {
    commandRef.current = onCommand;
  }, [onCommand]);

  useEffect(() => {
    recordRunRef.current = gameStats.recordRun;
  }, [gameStats.recordRun]);

  useEffect(() => {
    joystickRef.current = {
      x: joystickX,
      y: joystickY,
      pressed: joystickPressed,
    };
  }, [joystickPressed, joystickX, joystickY]);

  useEffect(() => {
    centerRef.current = center;
  }, [center]);

  useEffect(() => {
    invertYRef.current = invertY;
  }, [invertY]);

  useEffect(() => {
    soundRef.current = soundEnabled;
  }, [soundEnabled]);

  const ensureAudioContext = useCallback(() => {
    if (typeof window === "undefined") return null;
    const AudioContextConstructor =
      window.AudioContext ||
      (window as WebAudioWindow).webkitAudioContext;
    if (!AudioContextConstructor) return null;
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextConstructor();
    }
    return audioContextRef.current;
  }, []);

  const stopBrowserMusic = useCallback(() => {
    if (musicTimerRef.current !== null) {
      window.clearInterval(musicTimerRef.current);
      musicTimerRef.current = null;
    }

    const context = audioContextRef.current;
    const bus = musicBusRef.current;
    musicBusRef.current = null;
    if (context && bus) {
      const now = context.currentTime;
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), now);
      bus.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);
      window.setTimeout(() => bus.disconnect(), 80);
    }
  }, []);

  const startBrowserMusic = useCallback(() => {
    if (
      connection !== "demo" ||
      !soundRef.current ||
      musicTimerRef.current !== null
    ) {
      return;
    }

    const context = ensureAudioContext();
    if (!context) return;
    void context.resume();

    const bus = context.createGain();
    bus.gain.setValueAtTime(0.28, context.currentTime);
    bus.connect(context.destination);
    musicBusRef.current = bus;
    musicNextTimeRef.current = context.currentTime + 0.04;

    const scheduleAhead = () => {
      const track = getTrack(selectedTrackRef.current);

      while (musicNextTimeRef.current < context.currentTime + 0.45) {
        const step = musicStepRef.current % track.notes.length;
        const stepSeconds = getTrackStepSeconds(track, step);
        const startsAt = musicNextTimeRef.current;
        const leadFrequency = track.notes[step];

        scheduleBrowserTone(
          context,
          bus,
          leadFrequency,
          startsAt,
          stepSeconds * 0.82,
          "square",
          0.11,
        );

        const beatInBar = step % 4;
        if (beatInBar === 0 || beatInBar === 2) {
          const root =
            track.bassRoots[
              Math.floor(step / 4) % track.bassRoots.length
            ];
          scheduleBrowserTone(
            context,
            bus,
            beatInBar === 0 ? root : root * 2,
            startsAt,
            stepSeconds * (beatInBar === 0 ? 1.75 : 0.72),
            "triangle",
            beatInBar === 0 ? 0.16 : 0.09,
          );
        }

        musicStepRef.current++;
        musicNextTimeRef.current += stepSeconds;
        setTrackStep(musicStepRef.current % track.notes.length);
      }
    };

    scheduleAhead();
    musicTimerRef.current = window.setInterval(scheduleAhead, 120);
  }, [connection, ensureAudioContext]);

  const stopSerialMusic = useCallback(
    (notifyArduino = true) => {
      if (serialMusicTimerRef.current !== null) {
        window.clearTimeout(serialMusicTimerRef.current);
        serialMusicTimerRef.current = null;
      }
      if (notifyArduino && connection === "connected") {
        commandRef.current("TRACK:STOP");
      }
    },
    [connection],
  );

  const startSerialMusic = useCallback(() => {
    if (
      connection !== "connected" ||
      !soundRef.current ||
      serialMusicTimerRef.current !== null
    ) {
      return;
    }

    commandRef.current("TRACK:START");

    const playNextStep = () => {
      if (
        connection !== "connected" ||
        !soundRef.current ||
        playerStateRef.current !== "playing"
      ) {
        serialMusicTimerRef.current = null;
        return;
      }

      const track = getTrack(selectedTrackRef.current);
      const step = serialMusicStepRef.current % track.notes.length;
      const stepDurationMs = Math.round(getTrackStepSeconds(track, step) * 1000);
      const toneDurationMs = Math.round(stepDurationMs * 0.82);

      commandRef.current(
        `TRACK:TONE:${track.notes[step]}:${toneDurationMs}`,
      );
      serialMusicStepRef.current++;
      setTrackStep(serialMusicStepRef.current % track.notes.length);
      serialMusicTimerRef.current = window.setTimeout(
        playNextStep,
        stepDurationMs,
      );
    };

    playNextStep();
  }, [connection]);

  const startTrackPlayback = useCallback(
    (restart: boolean) => {
      stopBrowserMusic();
      stopSerialMusic(false);

      if (restart) {
        musicStepRef.current = 0;
        serialMusicStepRef.current = 0;
        setTrackStep(0);
      }

      if (!soundRef.current) {
        playerStateRef.current = "paused";
        setPlayerState("paused");
        return;
      }

      playerStateRef.current = "playing";
      setPlayerState("playing");

      if (connection === "demo") {
        startBrowserMusic();
      } else if (connection === "connected") {
        startSerialMusic();
      }
    },
    [
      connection,
      startBrowserMusic,
      startSerialMusic,
      stopBrowserMusic,
      stopSerialMusic,
    ],
  );

  const pauseTrackPlayback = useCallback(() => {
    stopBrowserMusic();
    stopSerialMusic();
    playerStateRef.current = "paused";
    setPlayerState("paused");
  }, [stopBrowserMusic, stopSerialMusic]);

  const stopTrackPlayback = useCallback(() => {
    stopBrowserMusic();
    stopSerialMusic();
    musicStepRef.current = 0;
    serialMusicStepRef.current = 0;
    setTrackStep(0);
    playerStateRef.current = "stopped";
    setPlayerState("stopped");
  }, [stopBrowserMusic, stopSerialMusic]);

  const playBrowserEffect = useCallback(
    (effect: "SHOT" | "SCORE" | "CRASH" | "OVER") => {
      if (
        connection !== "demo" ||
        !soundRef.current ||
        effectsVolumeRef.current <= 0
      ) {
        return;
      }
      const context = ensureAudioContext();
      if (!context) return;
      void context.resume();
      const now = context.currentTime + 0.005;
      const volumeScale = effectsVolumeRef.current / 28;
      const scaledVolume = (baseVolume: number) =>
        Math.min(0.35, baseVolume * volumeScale);

      if (effect === "SHOT") {
        scheduleBrowserTone(
          context,
          context.destination,
          1568,
          now,
          0.055,
          "square",
          scaledVolume(0.07),
        );
      } else if (effect === "SCORE") {
        scheduleBrowserTone(
          context,
          context.destination,
          988,
          now,
          0.08,
          "square",
          scaledVolume(0.075),
        );
        scheduleBrowserTone(
          context,
          context.destination,
          1568,
          now + 0.075,
          0.11,
          "square",
          scaledVolume(0.075),
        );
      } else if (effect === "CRASH") {
        scheduleBrowserTone(
          context,
          context.destination,
          110,
          now,
          0.22,
          "sawtooth",
          scaledVolume(0.09),
        );
      } else {
        [330, 247, 196, 123].forEach((frequency, index) => {
          scheduleBrowserTone(
            context,
            context.destination,
            frequency,
            now + index * 0.13,
            0.16,
            "square",
            scaledVolume(0.065),
          );
        });
      }
    },
    [connection, ensureAudioContext],
  );

  const emitSound = useCallback((effect: "SHOT" | "SCORE" | "CRASH" | "OVER") => {
    if (!soundRef.current) return;
    playBrowserEffect(effect);
    commandRef.current(`SFX:${effect}`);
  }, [playBrowserEffect]);

  useEffect(() => {
    if (connection !== "demo") stopBrowserMusic();
    if (connection !== "connected") stopSerialMusic(false);
  }, [connection, stopBrowserMusic, stopSerialMusic]);

  useEffect(() => {
    return () => {
      stopBrowserMusic();
      stopSerialMusic(false);
      const context = audioContextRef.current;
      audioContextRef.current = null;
      if (context && context.state !== "closed") void context.close();
    };
  }, [stopBrowserMusic, stopSerialMusic]);

  const drawWorld = useCallback((world: GameWorld) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    context.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    const backdrop = context.createLinearGradient(0, 0, 0, GAME_HEIGHT);
    backdrop.addColorStop(0, "#071a21");
    backdrop.addColorStop(0.58, "#0a2630");
    backdrop.addColorStop(1, "#103238");
    context.fillStyle = backdrop;
    context.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    const glow = context.createRadialGradient(
      GAME_WIDTH * 0.78,
      GAME_HEIGHT * 0.1,
      0,
      GAME_WIDTH * 0.78,
      GAME_HEIGHT * 0.1,
      GAME_WIDTH * 0.6,
    );
    glow.addColorStop(0, "rgba(86, 215, 191, 0.16)");
    glow.addColorStop(1, "rgba(86, 215, 191, 0)");
    context.fillStyle = glow;
    context.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    for (const star of world.stars) {
      context.fillStyle = `rgba(224, 255, 246, ${star.alpha})`;
      context.beginPath();
      context.arc(star.x, star.y, star.size, 0, Math.PI * 2);
      context.fill();
    }

    context.strokeStyle = "rgba(86, 215, 191, 0.08)";
    context.lineWidth = 1;
    for (let x = 0; x < GAME_WIDTH; x += 60) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, GAME_HEIGHT);
      context.stroke();
    }
    for (let y = 0; y < GAME_HEIGHT; y += 60) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(GAME_WIDTH, y);
      context.stroke();
    }

    for (const bullet of world.bullets) {
      const bulletGlow = context.createLinearGradient(
        bullet.x,
        bullet.y - 12,
        bullet.x,
        bullet.y + 8,
      );
      bulletGlow.addColorStop(0, "rgba(215, 245, 90, 0)");
      bulletGlow.addColorStop(0.35, "#d7f55a");
      bulletGlow.addColorStop(1, "#ffffff");
      context.fillStyle = bulletGlow;
      roundedRect(context, bullet.x - 3, bullet.y - 13, 6, 21, 3);
      context.fill();
    }

    for (const asteroid of world.asteroids) {
      context.save();
      context.translate(asteroid.x, asteroid.y);
      context.rotate(asteroid.rotation);

      const rockGradient = context.createRadialGradient(
        -asteroid.radius * 0.3,
        -asteroid.radius * 0.3,
        asteroid.radius * 0.1,
        0,
        0,
        asteroid.radius,
      );
      rockGradient.addColorStop(0, "#d7a47b");
      rockGradient.addColorStop(0.48, "#9c624d");
      rockGradient.addColorStop(1, "#543b3b");
      context.fillStyle = rockGradient;
      context.strokeStyle = "#f2b68d";
      context.lineWidth = 2;
      context.beginPath();
      for (let point = 0; point < 10; point++) {
        const angle = (point / 10) * Math.PI * 2;
        const wobble = point % 2 === 0 ? 1 : 0.78;
        const px = Math.cos(angle) * asteroid.radius * wobble;
        const py = Math.sin(angle) * asteroid.radius * wobble;
        if (point === 0) context.moveTo(px, py);
        else context.lineTo(px, py);
      }
      context.closePath();
      context.fill();
      context.stroke();

      context.fillStyle = "rgba(64, 38, 40, 0.55)";
      context.beginPath();
      context.arc(
        -asteroid.radius * 0.22,
        -asteroid.radius * 0.14,
        asteroid.radius * 0.18,
        0,
        Math.PI * 2,
      );
      context.fill();
      context.restore();
    }

    context.save();
    context.translate(world.shipX, world.shipY);

    const flameLength =
      statusRef.current === "playing"
        ? 20 + Math.sin(performance.now() / 48) * 5
        : 8;
    const flame = context.createLinearGradient(0, 16, 0, 16 + flameLength);
    flame.addColorStop(0, "#fff4a4");
    flame.addColorStop(0.45, "#ff6b3d");
    flame.addColorStop(1, "rgba(255, 107, 61, 0)");
    context.fillStyle = flame;
    context.beginPath();
    context.moveTo(-8, 15);
    context.lineTo(0, 17 + flameLength);
    context.lineTo(8, 15);
    context.closePath();
    context.fill();

    context.shadowColor = "#56d7bf";
    context.shadowBlur = 18;
    context.fillStyle = "#56d7bf";
    context.strokeStyle = "#d9fff7";
    context.lineWidth = 2.5;
    context.beginPath();
    context.moveTo(0, -25);
    context.lineTo(20, 20);
    context.lineTo(0, 12);
    context.lineTo(-20, 20);
    context.closePath();
    context.fill();
    context.stroke();
    context.shadowBlur = 0;

    context.fillStyle = "#08232b";
    context.beginPath();
    context.ellipse(0, -4, 6.5, 11, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();

    context.fillStyle = "rgba(3, 16, 20, 0.78)";
    roundedRect(context, 18, 16, 188, 45, 12);
    context.fill();
    context.fillStyle = "#d7f55a";
    context.font = "800 18px Arial";
    context.fillText(`${copy.canvasScore} ${world.score}`, 34, 45);

    if (statusRef.current !== "playing") {
      context.fillStyle = "rgba(3, 14, 18, 0.68)";
      context.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
      context.textAlign = "center";
      context.fillStyle = "#ffffff";
      context.font = "900 42px Arial";
      const title =
        statusRef.current === "paused"
          ? copy.canvasPause
          : statusRef.current === "over"
            ? copy.canvasOver
            : copy.canvasTitle;
      context.fillText(title, GAME_WIDTH / 2, GAME_HEIGHT / 2 - 20);
      context.fillStyle = "#b8cbc6";
      context.font = "600 17px Arial";
      const subtitle =
        statusRef.current === "over"
          ? copy.canvasResult(world.score)
          : statusRef.current === "paused"
            ? copy.canvasContinue
            : copy.canvasInstructions;
      context.fillText(subtitle, GAME_WIDTH / 2, GAME_HEIGHT / 2 + 20);
      context.textAlign = "start";
    }
  }, [copy]);

  const shoot = useCallback((now: number) => {
    const world = worldRef.current;
    if (now - world.lastShot < 220 || statusRef.current !== "playing") return;
    world.lastShot = now;
    world.bullets.push({
      x: world.shipX,
      y: world.shipY - 25,
      speed: 550,
    });
    emitSound("SHOT");
  }, [emitSound]);

  const recordActiveRun = useCallback(() => {
    const runId = activeRunIdRef.current;
    if (!runId) return false;

    activeRunIdRef.current = null;
    const world = worldRef.current;
    return recordRunRef.current({
      runId,
      score: world.score,
      level: world.level,
      durationMs: Math.max(0, Math.round(world.elapsed * 1000)),
    });
  }, []);

  const finishGame = useCallback(() => {
    if (statusRef.current === "over") return;
    statusRef.current = "over";
    setStatus("over");
    recordActiveRun();
    stopTrackPlayback();
    playBrowserEffect("OVER");
    commandRef.current("GAME:OVER");
  }, [playBrowserEffect, recordActiveRun, stopTrackPlayback]);

  const updateWorld = useCallback((now: number) => {
    const world = worldRef.current;
    const elapsedSeconds = Math.min(0.034, (now - world.lastFrame) / 1000);
    world.lastFrame = now;

    for (const star of world.stars) {
      star.y += star.speed * elapsedSeconds;
      if (star.y > GAME_HEIGHT + 4) {
        star.y = -4;
        star.x = Math.random() * GAME_WIDTH;
      }
    }

    if (statusRef.current !== "playing") {
      drawWorld(world);
      animationRef.current = requestAnimationFrame(updateWorld);
      return;
    }

    world.elapsed += elapsedSeconds;
    const newLevel = Math.min(9, 1 + Math.floor(world.elapsed / 22));
    if (newLevel !== world.level) {
      world.level = newLevel;
      setLevel(newLevel);
    }

    const keys = keyboardRef.current;
    const touches = touchRef.current;
    const horizontalKey =
      (keys.has("ArrowRight") || keys.has("KeyD") || touches.has("right")
        ? 1
        : 0) -
      (keys.has("ArrowLeft") || keys.has("KeyA") || touches.has("left")
        ? 1
        : 0);
    const verticalKey =
      (keys.has("ArrowDown") || keys.has("KeyS") || touches.has("down")
        ? 1
        : 0) -
      (keys.has("ArrowUp") || keys.has("KeyW") || touches.has("up")
        ? 1
        : 0);

    const rawHorizontal = normalizeAxis(
      joystickRef.current.x,
      centerRef.current.x,
    );
    const rawVertical = normalizeAxis(
      joystickRef.current.y,
      centerRef.current.y,
    );
    const physicalVertical = invertYRef.current ? rawVertical : -rawVertical;
    const virtual = virtualJoystickRef.current;
    const joystickHorizontal = virtual.active ? virtual.x : rawHorizontal;
    const joystickVertical = virtual.active ? virtual.y : physicalVertical;
    const moveX = Math.max(
      -1,
      Math.min(1, joystickHorizontal + horizontalKey),
    );
    const moveY = Math.max(
      -1,
      Math.min(1, joystickVertical + verticalKey),
    );
    const shipSpeed = 330 + world.level * 8;

    world.shipX = Math.max(
      SHIP_RADIUS + 8,
      Math.min(
        GAME_WIDTH - SHIP_RADIUS - 8,
        world.shipX + moveX * shipSpeed * elapsedSeconds,
      ),
    );
    world.shipY = Math.max(
      SHIP_RADIUS + 8,
      Math.min(
        GAME_HEIGHT - SHIP_RADIUS - 8,
        world.shipY + moveY * shipSpeed * elapsedSeconds,
      ),
    );

    const pressed =
      joystickRef.current.pressed ||
      keys.has("Space") ||
      touches.has("fire");
    if (pressed && !previousPressRef.current) shoot(now);
    if (pressed && now - world.lastShot >= 280) shoot(now);
    previousPressRef.current = pressed;

    const spawnInterval = Math.max(360, 920 - world.level * 62);
    if (now - world.lastSpawn >= spawnInterval) {
      world.lastSpawn = now;
      const radius = 17 + Math.random() * 20;
      world.asteroids.push({
        x: radius + Math.random() * (GAME_WIDTH - radius * 2),
        y: -radius - 10,
        radius,
        speed: 82 + world.level * 15 + Math.random() * 58,
        drift: (Math.random() - 0.5) * 36,
        spin: (Math.random() - 0.5) * 2.2,
        rotation: Math.random() * Math.PI,
        health: radius > 30 ? 2 : 1,
      });
    }

    for (const bullet of world.bullets) {
      bullet.y -= bullet.speed * elapsedSeconds;
    }
    world.bullets = world.bullets.filter((bullet) => bullet.y > -30);

    for (const asteroid of world.asteroids) {
      asteroid.y += asteroid.speed * elapsedSeconds;
      asteroid.x += asteroid.drift * elapsedSeconds;
      asteroid.rotation += asteroid.spin * elapsedSeconds;
      if (asteroid.x < -asteroid.radius) asteroid.x = GAME_WIDTH + asteroid.radius;
      if (asteroid.x > GAME_WIDTH + asteroid.radius) asteroid.x = -asteroid.radius;
    }

    const removedBullets = new Set<Bullet>();
    const removedAsteroids = new Set<Asteroid>();

    for (const bullet of world.bullets) {
      for (const asteroid of world.asteroids) {
        if (
          !removedAsteroids.has(asteroid) &&
          circlesTouch(bullet.x, bullet.y, 5, asteroid.x, asteroid.y, asteroid.radius)
        ) {
          removedBullets.add(bullet);
          asteroid.health--;
          if (asteroid.health <= 0) {
            removedAsteroids.add(asteroid);
            world.score += 10 * world.level;
            setScore(world.score);
            emitSound("SCORE");
          }
          break;
        }
      }
    }

    for (const asteroid of world.asteroids) {
      if (
        !removedAsteroids.has(asteroid) &&
        circlesTouch(
          world.shipX,
          world.shipY,
          SHIP_RADIUS,
          asteroid.x,
          asteroid.y,
          asteroid.radius * 0.82,
        )
      ) {
        removedAsteroids.add(asteroid);
        world.lives = Math.max(0, world.lives - 1);
        setLives(world.lives);
        emitSound("CRASH");
        if (world.lives === 0) {
          finishGame();
          break;
        }
      } else if (asteroid.y - asteroid.radius > GAME_HEIGHT) {
        removedAsteroids.add(asteroid);
      }
    }

    if (removedBullets.size > 0) {
      world.bullets = world.bullets.filter(
        (bullet) => !removedBullets.has(bullet),
      );
    }
    if (removedAsteroids.size > 0) {
      world.asteroids = world.asteroids.filter(
        (asteroid) => !removedAsteroids.has(asteroid),
      );
    }

    drawWorld(world);
    animationRef.current = requestAnimationFrame(updateWorld);
  }, [drawWorld, emitSound, finishGame, shoot]);

  useEffect(() => {
    worldRef.current.lastFrame = performance.now();
    drawWorld(worldRef.current);
    animationRef.current = requestAnimationFrame(updateWorld);
    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [drawWorld, updateWorld]);

  useEffect(() => {
    const handlePageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) recordActiveRun();
    };

    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      recordActiveRun();
    };
  }, [recordActiveRun]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        statusRef.current !== "playing" ||
        isNativeKeyboardControl(event.target)
      ) {
        return;
      }
      if (
        [
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Space",
          "KeyW",
          "KeyA",
          "KeyS",
          "KeyD",
        ].includes(event.code)
      ) {
        event.preventDefault();
        keyboardRef.current.add(event.code);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      keyboardRef.current.delete(event.code);
    };
    const onBlur = () => keyboardRef.current.clear();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    if (connection !== "disconnected") return;

    if (
      statusRef.current === "playing" ||
      statusRef.current === "paused"
    ) {
      recordActiveRun();
      statusRef.current = "ready";
      setStatus("ready");
      worldRef.current = createWorld();
      setScore(0);
      setLives(3);
      setLevel(1);
      keyboardRef.current.clear();
      touchRef.current.clear();
      const centredJoystick = { x: 0, y: 0, active: false };
      virtualJoystickRef.current = centredJoystick;
      virtualJoystickPointerRef.current = null;
      setVirtualJoystick(centredJoystick);
      resumeMusicAfterGamePauseRef.current = false;
    }

    if (playerStateRef.current !== "stopped") stopTrackPlayback();
  }, [connection, recordActiveRun, stopTrackPlayback]);

  const startGame = () => {
    if (!gameStats.profile) return;
    const world = createWorld();
    worldRef.current = world;
    activeRunIdRef.current = generateRunId();
    previousPressRef.current = joystickRef.current.pressed;
    statusRef.current = "playing";
    setStatus("playing");
    setScore(0);
    setLives(3);
    setLevel(1);
    onCommand("GAME:1");
    onCommand(`GAME:SOUND:${soundRef.current ? 1 : 0}`);
    onCommand(`SFX:VOLUME:${effectsVolume}`);
    startTrackPlayback(true);
    window.requestAnimationFrame(() => canvasRef.current?.focus());
  };

  const togglePause = () => {
    if (statusRef.current === "playing") {
      statusRef.current = "paused";
      setStatus("paused");
      resumeMusicAfterGamePauseRef.current =
        playerStateRef.current === "playing";
      if (resumeMusicAfterGamePauseRef.current) pauseTrackPlayback();
      onCommand("GAME:PAUSE");
    } else if (statusRef.current === "paused") {
      worldRef.current.lastFrame = performance.now();
      statusRef.current = "playing";
      setStatus("playing");
      onCommand("GAME:RESUME");
      if (resumeMusicAfterGamePauseRef.current) {
        startTrackPlayback(false);
      }
      resumeMusicAfterGamePauseRef.current = false;
      window.requestAnimationFrame(() => canvasRef.current?.focus());
    }
  };

  const stopGame = () => {
    recordActiveRun();
    statusRef.current = "ready";
    setStatus("ready");
    worldRef.current = createWorld();
    const centredJoystick = { x: 0, y: 0, active: false };
    virtualJoystickRef.current = centredJoystick;
    virtualJoystickPointerRef.current = null;
    setVirtualJoystick(centredJoystick);
    stopTrackPlayback();
    setScore(0);
    setLives(3);
    setLevel(1);
    onCommand("GAME:0");
  };

  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    soundRef.current = next;
    if (connection === "connected" || connection === "demo") {
      onCommand(`GAME:SOUND:${next ? 1 : 0}`);
    }
    if (!next) {
      if (playerStateRef.current === "playing") pauseTrackPlayback();
    } else if (playerStateRef.current === "paused") {
      startTrackPlayback(false);
    }
  };

  const changeEffectsVolume = (volume: number) => {
    effectsVolumeRef.current = volume;
    setEffectsVolume(volume);
    if (connection === "connected" || connection === "demo") {
      onCommand(`SFX:VOLUME:${volume}`);
    }
  };

  const changeTrack = (trackId: TrackId) => {
    selectedTrackRef.current = trackId;
    setSelectedTrackId(trackId);
    const shouldRestart = playerStateRef.current === "playing";
    musicStepRef.current = 0;
    serialMusicStepRef.current = 0;
    setTrackStep(0);
    if (shouldRestart) startTrackPlayback(true);
  };

  const togglePlayer = () => {
    if (playerStateRef.current === "playing") {
      pauseTrackPlayback();
      return;
    }
    if (!soundRef.current) {
      soundRef.current = true;
      setSoundEnabled(true);
      onCommand("GAME:SOUND:1");
    }
    startTrackPlayback(playerStateRef.current === "stopped");
  };

  const calibrate = () => {
    const nextCenter = {
      x: Math.round(joystickX),
      y: Math.round(joystickY),
    };
    setCenter(nextCenter);
  };

  const setTouchControl = (
    control: string,
    active: boolean,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    if (active) {
      event.currentTarget.setPointerCapture(event.pointerId);
      touchRef.current.add(control);
    } else {
      touchRef.current.delete(control);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  };

  const setKeyboardControl = (
    control: string,
    active: boolean,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (active) touchRef.current.add(control);
    else touchRef.current.delete(control);
  };

  const pulseAccessibleControl = (control: string) => {
    touchRef.current.add(control);
    window.setTimeout(() => touchRef.current.delete(control), 180);
  };

  const updateVirtualJoystick = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const travelRadius = Math.max(
      1,
      Math.min(bounds.width, bounds.height) / 2 - 34,
    );
    let x = (event.clientX - (bounds.left + bounds.width / 2)) / travelRadius;
    let y = (event.clientY - (bounds.top + bounds.height / 2)) / travelRadius;
    const distance = Math.hypot(x, y);

    if (distance > 1) {
      x /= distance;
      y /= distance;
    }

    const nextJoystick = { x, y, active: true };
    virtualJoystickRef.current = nextJoystick;
    setVirtualJoystick(nextJoystick);
  };

  const startVirtualJoystick = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    virtualJoystickPointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedOnKnob:
        event.target instanceof Element &&
        Boolean(event.target.closest(".joystick-knob")),
    };
    updateVirtualJoystick(event);
  };

  const moveVirtualJoystick = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (virtualJoystickPointerRef.current?.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    updateVirtualJoystick(event);
  };

  const stopVirtualJoystick = (
    event: ReactPointerEvent<HTMLDivElement>,
    allowTap: boolean,
  ) => {
    const activePointer = virtualJoystickPointerRef.current;
    if (activePointer?.pointerId !== event.pointerId) return;

    event.preventDefault();
    const wasKnobTap =
      allowTap &&
      activePointer.startedOnKnob &&
      Math.hypot(
        event.clientX - activePointer.startX,
        event.clientY - activePointer.startY,
      ) < 12;

    virtualJoystickPointerRef.current = null;
    const centredJoystick = { x: 0, y: 0, active: false };
    virtualJoystickRef.current = centredJoystick;
    setVirtualJoystick(centredJoystick);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (wasKnobTap) shoot(performance.now());
  };

  const physicalNormalizedX = normalizeAxis(joystickX, center.x);
  const physicalNormalizedY =
    normalizeAxis(joystickY, center.y) * (invertY ? 1 : -1);
  const normalizedX = virtualJoystick.active
    ? virtualJoystick.x
    : physicalNormalizedX;
  const normalizedY = virtualJoystick.active
    ? virtualJoystick.y
    : physicalNormalizedY;
  const displayedJoystickX = virtualJoystick.active
    ? Math.round(512 + virtualJoystick.x * 511)
    : Math.round(joystickX);
  const displayedJoystickY = virtualJoystick.active
    ? Math.round(512 + virtualJoystick.y * 511)
    : Math.round(joystickY);
  const connected = connection === "connected" || connection === "demo";
  const selectedTrack = getTrack(selectedTrackId);
  const trackLabels: Record<TrackId, string> = {
    space: copy.trackSpace,
    neon: copy.trackNeon,
    boss: copy.trackBoss,
    joy: copy.trackJoy,
    elise: copy.trackElise,
    bells: copy.trackBells,
    anthem: copy.trackAnthem,
  };
  const selectedTrackName = trackLabels[selectedTrackId];
  const playerProgress =
    (trackStep / Math.max(1, selectedTrack.notes.length)) * 100;
  const playerOutput =
    connection === "connected"
      ? copy.buzzerOutput
      : connection === "demo"
        ? copy.phoneOutput
        : copy.playerOffline;

  return (
    <section className="game-tab" id="game">
      <div className="game-intro">
        <div>
          <p className="eyebrow">{copy.introEyebrow}</p>
          <h1>{copy.title}</h1>
          <p>{copy.intro}</p>
        </div>
        <div className="game-legend">
          <span><kbd>↕ ↔</kbd> {copy.move}</span>
          <span><kbd>SW</kbd> {copy.fire}</span>
          <span><kbd>3</kbd> {copy.lives}</span>
        </div>
      </div>

      <PlayerStatsPanel
        copy={copy}
        disabled={status === "playing" || status === "paused"}
        language={language}
        stats={gameStats}
      />

      <div className="game-console">
        <div className="game-stage-card">
          <div className="game-hud">
            <div>
              <small>{copy.score}</small>
              <strong>{score.toString().padStart(5, "0")}</strong>
            </div>
            <div>
              <small>{copy.lives.toUpperCase()}</small>
              <strong className="lives" aria-label={copy.livesAria(lives)}>
                {"◆".repeat(Math.max(0, lives))}
                <span>{"◇".repeat(Math.max(0, 3 - lives))}</span>
              </strong>
            </div>
            <div>
              <small>{copy.level}</small>
              <strong>{level}</strong>
            </div>
            <button
              className={`sound-toggle ${soundEnabled ? "active" : ""}`}
              onClick={toggleSound}
              type="button"
            >
              {soundEnabled ? `♪ ${selectedTrackName}` : copy.soundOff}
            </button>
          </div>

          <div className="game-canvas-wrap">
            <canvas
              aria-label={copy.canvasAria}
              className="game-canvas"
              height={GAME_HEIGHT}
              onPointerDown={() => canvasRef.current?.focus()}
              ref={canvasRef}
              tabIndex={0}
              width={GAME_WIDTH}
            />

            {!connected && (
              <div
                aria-busy={connection === "connecting"}
                className="game-connect-overlay"
              >
                <strong>{copy.connectFirst}</strong>
                <p>{copy.demoHint}</p>
                <div>
                  {isSupported ? (
                    <button
                      className="button primary"
                      disabled={connection === "connecting"}
                      onClick={onConnect}
                    >
                      {copy.connectArduino}
                    </button>
                  ) : (
                    <button
                      className="button primary"
                      disabled={connection === "connecting"}
                      onClick={onStartDemo}
                    >
                      {copy.startDemo}
                    </button>
                  )}
                  {isSupported && (
                    <button
                      className="button secondary"
                      disabled={connection === "connecting"}
                      onClick={onStartDemo}
                    >
                      {copy.demoWithoutBoard}
                    </button>
                  )}
                </div>
                {!isSupported && (
                  <small>{copy.usbNote}</small>
                )}
              </div>
            )}
          </div>

          <div className="game-actions">
            {status === "ready" || status === "over" ? (
              <button
                className="button game-start"
                disabled={!connected || !gameStats.profile}
                onClick={startGame}
              >
                {status === "over" ? copy.playAgain : copy.startGame}
              </button>
            ) : (
              <button className="button game-pause" onClick={togglePause}>
                {status === "paused" ? copy.continueGame : copy.pause}
              </button>
            )}
            <button
              className="button game-stop"
              disabled={status === "ready"}
              onClick={stopGame}
            >
              {copy.finish}
            </button>
          </div>

          {error && <p className="error-message game-error">{error}</p>}
        </div>

        <aside className="game-side-panel">
          <div className="joystick-card">
            <div className="game-card-heading">
              <div>
                <span className="game-kicker">{copy.liveSignal}</span>
                <h2>{copy.yourJoystick}</h2>
              </div>
              <span
                className={`joystick-link ${connection}`}
                title={connected ? copy.signalReceived : copy.noConnection}
              />
            </div>

            <div
              aria-label={copy.touchJoystickAria}
              className={`joystick-visual ${
                virtualJoystick.active ? "dragging" : ""
              }`}
              onPointerCancel={(event) => stopVirtualJoystick(event, false)}
              onPointerDown={startVirtualJoystick}
              onPointerMove={moveVirtualJoystick}
              onPointerUp={(event) => stopVirtualJoystick(event, true)}
              role="group"
            >
              <div className="joystick-crosshair" />
              <div
                className={`joystick-knob ${
                  joystickPressed || virtualJoystick.active ? "pressed" : ""
                }`}
                style={{
                  transform: `translate(calc(-50% + ${normalizedX * 46}px), calc(-50% + ${normalizedY * 46}px))`,
                }}
              >
                <span>SW</span>
              </div>
            </div>

            <div className="joystick-readings">
              <span><small>VRx · A0</small><strong>{displayedJoystickX}</strong></span>
              <span><small>VRy · A1</small><strong>{displayedJoystickY}</strong></span>
              <span><small>SW · D4</small><strong>{joystickPressed ? "CLICK" : "—"}</strong></span>
            </div>

            <p className="virtual-joystick-hint">{copy.touchJoystickHint}</p>

            <button
              className="calibrate-button"
              disabled={!connected}
              onClick={calibrate}
              type="button"
            >
              {copy.calibrate}
            </button>
            <p className="calibration-note">
              {copy.calibration(center.x, center.y)}
            </p>

            <label className="invert-control">
              <input
                checked={invertY}
                onChange={(event) => setInvertY(event.target.checked)}
                type="checkbox"
              />
              <span>{copy.verticalDirection}</span>
            </label>
          </div>

          <div className="chiptune-player-card">
            <div className="game-card-heading">
              <div>
                <span className="game-kicker">{copy.playerEyebrow}</span>
                <h2>{copy.playerTitle}</h2>
              </div>
              <span
                className={`player-state-dot ${
                  playerState === "playing" ? "playing" : ""
                }`}
                aria-hidden="true"
              />
            </div>

            <div
              className={`chiptune-now-playing ${
                playerState === "playing" ? "playing" : ""
              }`}
            >
              <div className="chiptune-equalizer" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
                <i />
              </div>
              <div>
                <small>{copy.nowPlaying}</small>
                <strong>{selectedTrackName}</strong>
                <span>
                  {selectedTrack.bpm} BPM · {copy.loopLabel}
                </span>
              </div>
            </div>

            <label className="track-picker">
              <span>{copy.chooseTrack}</span>
              <select
                aria-label={copy.chooseTrack}
                onChange={(event) =>
                  changeTrack(event.target.value as TrackId)
                }
                value={selectedTrackId}
              >
                {CHIPTUNE_TRACKS.map((track) => (
                  <option key={track.id} value={track.id}>
                    {trackLabels[track.id]}
                  </option>
                ))}
              </select>
            </label>

            <p className="recognizable-melody-hint">
              {copy.recognizableMelodyHint}
            </p>

            <div
              aria-label={copy.trackProgress}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={Math.round(playerProgress)}
              className="track-progress"
              role="progressbar"
            >
              <i style={{ width: `${playerProgress}%` }} />
            </div>

            <div className="player-controls">
              <button
                disabled={!connected}
                onClick={togglePlayer}
                type="button"
              >
                {playerState === "playing"
                  ? copy.pauseTrack
                  : copy.playTrack}
              </button>
              <button
                disabled={playerState === "stopped"}
                onClick={stopTrackPlayback}
                type="button"
              >
                {copy.stopTrack}
              </button>
            </div>

            <div className="player-output">
              <span>{playerState === "playing" ? "♪" : "○"}</span>
              <div>
                <strong>{playerOutput}</strong>
                <small>
                  {connection === "connected"
                    ? copy.buzzerStreamHint
                    : connection === "demo"
                      ? copy.phoneStreamHint
                      : copy.playerConnectHint}
                </small>
              </div>
            </div>
          </div>

          <div className="touch-controller">
            <div className="touch-dpad">
              {[
                ["up", "↑", copy.directionUp],
                ["left", "←", copy.directionLeft],
                ["down", "↓", copy.directionDown],
                ["right", "→", copy.directionRight],
              ].map(([control, label, ariaLabel]) => (
                <button
                  aria-label={ariaLabel}
                  className={control}
                  key={control}
                  onBlur={() => touchRef.current.delete(control)}
                  onClick={(event) => {
                    if (event.detail === 0) pulseAccessibleControl(control);
                  }}
                  onKeyDown={(event) =>
                    setKeyboardControl(control, true, event)
                  }
                  onKeyUp={(event) =>
                    setKeyboardControl(control, false, event)
                  }
                  onPointerCancel={(event) =>
                    setTouchControl(control, false, event)
                  }
                  onPointerDown={(event) =>
                    setTouchControl(control, true, event)
                  }
                  onPointerUp={(event) =>
                    setTouchControl(control, false, event)
                  }
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              aria-label={copy.fire}
              className="touch-fire"
              onBlur={() => touchRef.current.delete("fire")}
              onClick={(event) => {
                if (event.detail === 0) shoot(performance.now());
              }}
              onKeyDown={(event) =>
                setKeyboardControl("fire", true, event)
              }
              onKeyUp={(event) =>
                setKeyboardControl("fire", false, event)
              }
              onPointerCancel={(event) => setTouchControl("fire", false, event)}
              onPointerDown={(event) => setTouchControl("fire", true, event)}
              onPointerUp={(event) => setTouchControl("fire", false, event)}
              type="button"
            >
              FIRE
              <small>{copy.fire}</small>
            </button>
          </div>
          <p className="keyboard-hint">
            {copy.keyboardPrefix} <kbd>WASD</kbd> / <kbd>{copy.keyboardArrows}</kbd>
            {" + "}<kbd>{copy.keyboardSpace}</kbd>.
          </p>
        </aside>
      </div>

      <div className="game-wiring-section">
        <div className="game-wiring-copy">
          <p className="eyebrow">{copy.wiringEyebrow}</p>
          <h2>{copy.wiringTitle}</h2>
          <p>{copy.wiringIntro}</p>
          <div className="game-safety">
            <strong>{copy.disconnectUsb}</strong>
            {copy.wiringSafety}
          </div>
        </div>

        <div className="joystick-wiring-card">
          <div className="wiring-module-visual" aria-hidden="true">
            <div className="module-stick"><span /></div>
            <strong>JOYSTICK</strong>
            <div className="module-pins">
              <i>GND</i><i>+5V</i><i>VRx</i><i>VRy</i><i>SW</i>
            </div>
          </div>
          <div className="joystick-wire-list">
            <div><span>VRx</span><i>→</i><strong>A0</strong><small>{copy.horizontalMove}</small></div>
            <div><span>VRy</span><i>→</i><strong>A1</strong><small>{copy.verticalMove}</small></div>
            <div><span>SW</span><i>→</i><strong>D4</strong><small>{copy.clickFire}</small></div>
            <div><span>{copy.vccLabel}</span><i>→</i><strong>5V</strong><small>{copy.redRail}</small></div>
            <div><span>GND</span><i>→</i><strong>GND</strong><small>{copy.blueRail}</small></div>
          </div>
        </div>

        <div className="buzzer-routing-card">
          <div className="buzzer-routing-heading">
            <span aria-hidden="true">♫</span>
            <div>
              <strong>{copy.soundRoutingTitle}</strong>
              <p>{copy.soundRoutingIntro}</p>
            </div>
          </div>
          <div className="buzzer-routing-lines">
            <div className="passive-route">
              <small>PASSIVE BUZZER</small>
              <strong>D3</strong>
              <span>{copy.passiveMusicRoute}</span>
            </div>
            <div className="active-route">
              <small>ACTIVE BUZZER</small>
              <strong>D5</strong>
              <span>{copy.activeEffectsRoute}</span>
            </div>
          </div>
            <div className="active-buzzer-wire-list">
            <div><span>{copy.activeBuzzerLong}</span><i>→</i><strong>D5</strong></div>
            <div><span>{copy.activeBuzzerShort}</span><i>→</i><strong>GND</strong></div>
            </div>
          <label className="effects-volume-control">
            <span>{copy.effectsVolume}</span>
            <output>{effectsVolume}%</output>
            <input
              aria-label={copy.effectsVolume}
              max="100"
              min="0"
              onChange={(event) =>
                changeEffectsVolume(Number(event.target.value))
              }
              step="1"
              type="range"
              value={effectsVolume}
            />
          </label>
          <p className="active-buzzer-note">{copy.activeBuzzerNote}</p>
        </div>
      </div>

      <div className="game-update-note">
        <span>1</span>
        <div>
          <strong>{copy.firmwareTitle}</strong>
          <p>{copy.firmwareText}</p>
        </div>
        <a className="button primary" download href="/arduino-smart-gate.ino">
          {copy.firmwareButton}
        </a>
      </div>
    </section>
  );
}
