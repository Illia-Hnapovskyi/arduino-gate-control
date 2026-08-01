"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  GAME_ACHIEVEMENTS,
  generateRunId,
  type GameAchievementId,
  type PlayerProgression,
  type PlayerStats,
} from "../shared/gameStats";
import { GAME_COPY, SPACE_DEFENDER_COPY, type Language } from "./i18n";
import { LeaderboardPanel, PlayerStatsPanel } from "./PlayerStatsPanel";
import { useGameStats } from "./useGameStats";
import type { GameRunRecordResult } from "./useGameStats";
import { formatGameControlSummary, GameMenu } from "./game/GameMenu";
import { POWER_UP_BALANCE } from "./game/balance";
import {
  EMPTY_ACHIEVEMENT_STATS,
  accumulateAchievementStats,
  evaluateAchievements,
  previewAchievementStats,
  type AchievementId,
  type AchievementProgress,
  type AchievementRunFacts,
  type LifetimeAchievementStats,
} from "./game/achievements";
import { GameHud } from "./game/GameHud";
import {
  GameOverlay,
  GameToastStack,
  type GameToast,
  type RunResultView,
} from "./game/GameOverlays";
import {
  AchievementGallery,
  CareerStats,
  type AchievementView,
} from "./game/ProgressPanels";
import {
  effectiveReducedMotion,
  loadGamePreferences,
  saveGamePreferences,
  DEFAULT_GAME_PREFERENCES,
  type GamePreferences,
} from "./game/preferences";
import {
  isNativeKeyboardControl,
  resolveGameInput,
} from "./game/input";
import {
  canResumeRun,
  clearRunSnapshot,
  loadRunSnapshot,
  saveRunSnapshot,
  type RunSnapshot,
} from "./game/persistence";
import { renderGameWorld } from "./game/rendering";
import { checkpointGameWorld, restoreGameWorld } from "./game/resume";
import {
  createGameWorld,
  selectUpgrade,
  snapshotGameSummary,
  stepGameWorld,
  type GameEvent,
  type GameResultSummary,
  type GameToastId,
  type GameWorld,
} from "./game/runtime";
import { gameResultToStatsInput } from "./game/statsAdapter";
import type {
  DifficultyId,
  GameModeId,
  PowerUpId,
  SectorId,
  UpgradeId,
  UpgradeStacks,
} from "./game/types";
import { POWER_UP_IDS } from "./game/types";
import { useGameAudio } from "./game/useGameAudio";

type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "demo";

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
  onDataSafetyChange: (blocked: boolean) => void;
  onStartDemo: () => void;
};

type GameUiStatus = "menu" | "playing" | "paused" | "upgrade" | "over";

type HudSnapshot = {
  bossHealth?: number;
  bossMaxHealth?: number;
  bossPhase?: number;
  combo: number;
  energy: number;
  lives: number;
  maxLives: number;
  maxShield: number;
  phase: "telegraph" | "combat" | "rest" | "boss";
  powerActiveRemaining: number;
  powerCooldown: number;
  powerEnergyCost: number;
  powerId: PowerUpId;
  score: number;
  sector: SectorId;
  shield: number;
  upgrades: Array<{ id: UpgradeId; stacks: number }>;
  wave: number;
};

type VirtualJoystickState = {
  active: boolean;
  x: number;
  y: number;
};

const INITIAL_HUD: HudSnapshot = {
  combo: 0,
  energy: 100,
  lives: 3,
  maxLives: 3,
  maxShield: 100,
  phase: "telegraph",
  powerActiveRemaining: 0,
  powerCooldown: 0,
  powerEnergyCost: 0,
  powerId: "shield",
  score: 0,
  sector: "starfield",
  shield: 100,
  upgrades: [],
  wave: 1,
};

const ACHIEVEMENT_ICONS: Record<string, string> = {
  boss: "♛",
  combo: "×",
  controller: "⌁",
  crosshair: "◎",
  launch: "▲",
  level: "Ⅸ",
  medal: "◆",
  power: "ϟ",
  shield: "⬡",
  star: "✦",
  target: "⊙",
  timer: "◷",
};

type AchievementBaseline = {
  progress: Partial<Record<AchievementId, AchievementProgress>>;
  stats: LifetimeAchievementStats;
};

function createAchievementBaseline(
  profile: PlayerStats | null,
  progression: PlayerProgression | null,
): AchievementBaseline {
  const progress: AchievementBaseline["progress"] = {};
  for (const achievement of progression?.achievements ?? []) {
    const unlockedAtMs = achievement.unlockedAt
      ? Date.parse(achievement.unlockedAt)
      : Number.NaN;
    progress[achievement.achievementId] = {
      id: achievement.achievementId,
      progress: achievement.progress,
      target:
        GAME_ACHIEVEMENTS.find((item) => item.id === achievement.achievementId)
          ?.target ?? 1,
      unlockedAtMs: Number.isFinite(unlockedAtMs)
        ? Math.max(0, Math.floor(unlockedAtMs))
        : null,
    };
  }
  const usedPowers = (progression?.powers ?? [])
    .filter((power) => power.activatedCount > 0)
    .map((power) => power.powerId)
    .filter((id): id is PowerUpId => POWER_UP_IDS.includes(id as PowerUpId));
  return {
    progress,
    stats: {
      ...EMPTY_ACHIEVEMENT_STATS,
      gamesPlayed: profile?.gamesPlayed ?? 0,
      enemiesDestroyed: progression?.totals.enemiesDestroyed ?? 0,
      bossesDefeated: progression?.totals.bossesDefeated ?? 0,
      longestRunMs: progression?.totals.longestRunMs ?? 0,
      flawlessSectors: progress.flawless_sector?.progress ?? 0,
      longestCombo: progression?.totals.longestCombo ?? 0,
      highScore: profile?.highScore ?? 0,
      arduinoRuns: progression?.totals.arduinoRuns ?? 0,
      powerUpsUsed: usedPowers,
      maxThreatLevel: profile?.highestLevel ?? 0,
      bestAccuracyPermille:
        progression?.totals.bestAccuracyPermille ?? 0,
    },
  };
}

function achievementFacts(result: GameResultSummary): AchievementRunFacts {
  return {
    controller: result.controller,
    durationMs: result.durationMs,
    metrics: result.metrics,
    score: result.score,
    threatLevel: result.level,
  };
}

function worldToHud(world: GameWorld): HudSnapshot {
  const powerState = world.powerStates[world.equippedPowerUp];
  const capacitorDiscount =
    world.equippedPowerUp === "emp"
      ? (world.upgradeStacks["emp-capacitor"] ?? 0) * 8
      : 0;
  return {
    bossHealth: world.boss?.health,
    bossMaxHealth: world.boss?.maxHealth,
    bossPhase: world.boss?.phase,
    combo: world.combo,
    energy: world.player.energy,
    lives: world.player.lives,
    maxLives: world.player.maxLives,
    maxShield: world.player.maxShield,
    phase: world.boss ? "boss" : world.wavePhase,
    powerActiveRemaining: powerState
      ? Math.max(0, (powerState.activeUntilMs - world.elapsedMs) / 1_000)
      : 0,
    powerCooldown: powerState
      ? Math.max(0, (powerState.cooldownUntilMs - world.elapsedMs) / 1_000)
      : 0,
    powerEnergyCost: Math.max(
      0,
      POWER_UP_BALANCE[world.equippedPowerUp].energyCost - capacitorDiscount,
    ),
    powerId: world.equippedPowerUp,
    score: world.score,
    sector: world.sector,
    shield: world.player.shield,
    upgrades: (Object.entries(world.upgradeStacks) as Array<[
      UpgradeId,
      number,
    ]>)
      .filter(([, stacks]) => stacks > 0)
      .map(([id, stacks]) => ({ id, stacks })),
    wave: world.wave,
  };
}

function resultToView(
  result: GameResultSummary,
  previousHighScore: number,
  endedReason: string,
  saveStatus: GameRunRecordResult,
  unlockedAchievements: readonly GameAchievementId[],
): RunResultView {
  const shotsFired = Math.max(0, result.metrics.shotsFired);
  const saved = saveStatus === "queued" || saveStatus === "duplicate";
  return {
    accuracy:
      shotsFired > 0
        ? Math.min(1, result.metrics.shotsHit / shotsFired)
        : 0,
    bosses: result.metrics.bossesDefeated,
    durationSeconds: result.durationMs / 1_000,
    endedReason,
    enemies: result.metrics.enemiesDestroyed,
    longestCombo: result.metrics.longestCombo,
    newRecord: result.score > previousHighScore,
    recoveryExported: false,
    score: result.score,
    saveStatus,
    saved,
    unlockedAchievements: [...unlockedAchievements],
    victory: result.outcome === "victory",
    wave: result.wave,
  };
}

function isPlayableConnection(connection: ConnectionState) {
  return connection === "connected" || connection === "demo";
}

function getBrowserLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function displayGameKey(code: string) {
  if (code === "Space") return "SPACE";
  return code
    .replace(/^Key/, "")
    .replace(/^Digit/, "")
    .replace(/Left$|Right$/, "")
    .toUpperCase();
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
  onDataSafetyChange,
  onStartDemo,
}: GamePanelProps) {
  const legacyCopy = GAME_COPY[language];
  const copy = SPACE_DEFENDER_COPY[language];
  const gameStats = useGameStats({ language });
  const connected = isPlayableConnection(connection);

  const [uiStatus, setUiStatus] = useState<GameUiStatus>("menu");
  const [mode, setMode] = useState<GameModeId>("expedition");
  const [difficulty, setDifficulty] = useState<DifficultyId>("pilot");
  const [hud, setHud] = useState<HudSnapshot>(INITIAL_HUD);
  const [result, setResult] = useState<RunResultView | null>(null);
  const [checkpointError, setCheckpointError] = useState(false);
  const [toasts, setToasts] = useState<GameToast[]>([]);
  const [upgradeChoices, setUpgradeChoices] = useState<UpgradeId[]>([]);
  const [upgradeStacks, setUpgradeStacks] = useState<UpgradeStacks>({});
  const [resumeSnapshot, setResumeSnapshot] = useState<RunSnapshot | null>(() => {
    const storage = getBrowserLocalStorage();
    if (!storage) return null;
    const stored = loadRunSnapshot(storage, Date.now());
    return stored && canResumeRun(stored) ? stored : null;
  });
  const [preferences, setPreferences] = useState<GamePreferences>(() => {
    const storage = getBrowserLocalStorage();
    return storage
      ? loadGamePreferences(storage)
      : {
          ...DEFAULT_GAME_PREFERENCES,
          keyBindings: { ...DEFAULT_GAME_PREFERENCES.keyBindings },
        };
  });
  const [systemReducedMotion, setSystemReducedMotion] = useState(() =>
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [joystickCentre, setJoystickCentre] = useState({ x: 512, y: 512 });
  const [virtualJoystick, setVirtualJoystick] =
    useState<VirtualJoystickState>({ active: false, x: 0, y: 0 });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const worldRef = useRef<GameWorld | null>(null);
  const statusRef = useRef<GameUiStatus>("menu");
  const animationRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);
  const lastHudUpdateRef = useRef(0);
  const keyboardRef = useRef(new Set<string>());
  const touchRef = useRef(new Set<string>());
  const virtualJoystickRef = useRef<VirtualJoystickState>({
    active: false,
    x: 0,
    y: 0,
  });
  const virtualPointerRef = useRef<number | null>(null);
  const joystickRef = useRef({ pressed: false, x: 512, y: 512 });
  const joystickCentreRef = useRef({ x: 512, y: 512 });
  const physicalPressStartedRef = useRef<number | null>(null);
  const physicalPowerTriggeredRef = useRef(false);
  const commandRef = useRef(onCommand);
  const recordRunRef = useRef(gameStats.recordRun);
  const previousHighScoreRef = useRef(0);
  const recordedRunIdsRef = useRef(new Set<string>());
  const toastTimersRef = useRef(new Map<string, number>());
  const preferencesRef = useRef(preferences);
  const reducedMotionRef = useRef(false);
  const achievementWatchRef = useRef(false);
  const knownAchievementsRef = useRef(new Set<GameAchievementId>());
  const runAchievementIdsRef = useRef(new Set<GameAchievementId>());
  const achievementBaselineRef = useRef<AchievementBaseline>(
    createAchievementBaseline(null, null),
  );
  const previewAchievementsRef = useRef<(world: GameWorld) => void>(
    () => undefined,
  );
  const activeProfileOwnerRef = useRef<string | null>(null);
  const unmountingRef = useRef(false);
  const finishActiveRunRef = useRef<(reason: string, updateUi?: boolean) => void>(
    () => undefined,
  );
  const saveSafeCheckpointRef = useRef<(updateUi?: boolean) => boolean>(
    () => false,
  );

  const effectiveMotionReduction = effectiveReducedMotion(
    preferences.reducedMotion,
    systemReducedMotion,
  );
  const audio = useGameAudio({
    bossActive: hud.phase === "boss",
    connection,
    onCommand,
    preferences,
    sector: hud.sector,
    state: uiStatus,
  });
  const emitSfxRef = useRef(audio.emitSfx);
  const unlockAudioRef = useRef(audio.unlockAudio);

  useEffect(() => {
    commandRef.current = onCommand;
  }, [onCommand]);

  useEffect(() => {
    recordRunRef.current = gameStats.recordRun;
  }, [gameStats.recordRun]);

  useEffect(() => {
    emitSfxRef.current = audio.emitSfx;
    unlockAudioRef.current = audio.unlockAudio;
  }, [audio.emitSfx, audio.unlockAudio]);

  useEffect(() => {
    statusRef.current = uiStatus;
  }, [uiStatus]);

  const dataAtRisk = checkpointError || Boolean(result && !result.saved);

  useEffect(() => {
    onDataSafetyChange(dataAtRisk);
  }, [dataAtRisk, onDataSafetyChange]);

  useEffect(() => {
    if (!dataAtRisk) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dataAtRisk]);

  useEffect(() => {
    preferencesRef.current = preferences;
    reducedMotionRef.current = effectiveMotionReduction;
  }, [effectiveMotionReduction, preferences]);

  useEffect(() => {
    joystickRef.current = {
      pressed: joystickPressed,
      x: joystickX,
      y: joystickY,
    };
  }, [joystickPressed, joystickX, joystickY]);

  useEffect(() => {
    joystickCentreRef.current = joystickCentre;
  }, [joystickCentre]);

  useEffect(() => {
    virtualJoystickRef.current = virtualJoystick;
  }, [virtualJoystick]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystemReducedMotion(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const storage = getBrowserLocalStorage();
    if (storage) saveGamePreferences(storage, preferences);
  }, [preferences]);

  useEffect(() => {
    if (connection !== "connected") return;
    commandRef.current(
      `SFX:VOLUME:${Math.round(preferences.effectsVolume)}`,
    );
    commandRef.current(
      `GAME:SOUND:${
        preferences.effectsVolume > 0 || preferences.musicVolume > 0 ? 1 : 0
      }`,
    );
  }, [connection, preferences.effectsVolume, preferences.musicVolume]);

  const addToast = useCallback((toast: Omit<GameToast, "id">) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((current) => [...current.slice(-3), { ...toast, id }]);
    const timer = window.setTimeout(() => {
      toastTimersRef.current.delete(id);
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 3_800);
    toastTimersRef.current.set(id, timer);
  }, []);

  const announceAchievement = useCallback(
    (id: GameAchievementId) => {
      if (knownAchievementsRef.current.has(id)) return false;
      knownAchievementsRef.current.add(id);
      runAchievementIdsRef.current.add(id);
      const metadata = GAME_ACHIEVEMENTS.find((item) => item.id === id);
      addToast({
        icon: ACHIEVEMENT_ICONS[metadata?.icon ?? "star"] ?? "✦",
        kind: "achievement",
        subtitle: copy.achievements[id].description,
        title: copy.achievements[id].name,
      });
      emitSfxRef.current("ACH");
      return true;
    },
    [addToast, copy.achievements],
  );

  const previewLiveAchievements = useCallback(
    (world: GameWorld) => {
      const summary = snapshotGameSummary(world);
      const stats = previewAchievementStats(
        achievementBaselineRef.current.stats,
        achievementFacts(summary),
      );
      const evaluated = evaluateAchievements(
        stats,
        achievementBaselineRef.current.progress,
        Date.now(),
      );
      for (const id of evaluated.newlyUnlocked) {
        if (
          id === "first_run" ||
          id === "veteran_10" ||
          id === "arduino_pilot" ||
          id === "sharpshooter"
        ) {
          continue;
        }
        announceAchievement(id);
      }
    },
    [announceAchievement],
  );

  const finalizeRunAchievements = useCallback(
    (summary: GameResultSummary) => {
      const stats = accumulateAchievementStats(
        achievementBaselineRef.current.stats,
        achievementFacts(summary),
      );
      const evaluated = evaluateAchievements(
        stats,
        achievementBaselineRef.current.progress,
        Date.now(),
      );
      for (const id of evaluated.newlyUnlocked) announceAchievement(id);
      return GAME_ACHIEVEMENTS.map((item) => item.id).filter((id) =>
        runAchievementIdsRef.current.has(id),
      );
    },
    [announceAchievement],
  );

  useEffect(() => {
    previewAchievementsRef.current = previewLiveAchievements;
  }, [previewLiveAchievements]);

  useEffect(
    () => () => {
      for (const timer of toastTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      toastTimersRef.current.clear();
    },
    [],
  );

  const resetControls = useCallback(() => {
    keyboardRef.current.clear();
    touchRef.current.clear();
    virtualPointerRef.current = null;
    const centred = { active: false, x: 0, y: 0 };
    virtualJoystickRef.current = centred;
    setVirtualJoystick(centred);
    physicalPressStartedRef.current = null;
    physicalPowerTriggeredRef.current = false;
  }, []);

  const saveSafeCheckpoint = useCallback((updateUi = true) => {
    const world = worldRef.current;
    if (!world || world.status !== "upgrade") return false;
    try {
      const storage = getBrowserLocalStorage();
      if (!storage) {
        if (updateUi) setCheckpointError(true);
        return false;
      }
      const snapshot = checkpointGameWorld(
        world,
        Date.now(),
        activeProfileOwnerRef.current,
      );
      if (!saveRunSnapshot(storage, snapshot)) {
        if (updateUi) setCheckpointError(true);
        return false;
      }
      if (updateUi) {
        setResumeSnapshot(snapshot);
        setCheckpointError(false);
      }
      return true;
    } catch {
      if (updateUi) setCheckpointError(true);
      return false;
    }
  }, []);

  const clearStoredCheckpoint = useCallback(() => {
    const storage = getBrowserLocalStorage();
    if (!storage || !clearRunSnapshot(storage)) {
      setCheckpointError(true);
      return false;
    }
    setResumeSnapshot(null);
    setCheckpointError(false);
    return true;
  }, []);

  const finishWithResult = useCallback(
    (
      gameResult: GameResultSummary,
      endedReason: string,
      updateUi = true,
      playEndSound = false,
    ) => {
      if (recordedRunIdsRef.current.has(gameResult.runId)) return;
      resetControls();
      const unlockedAchievements = finalizeRunAchievements(gameResult);
      const recordStatus: GameRunRecordResult = recordRunRef.current(
        gameResultToStatsInput(gameResult, endedReason),
        activeProfileOwnerRef.current,
      );
      const saved = recordStatus === "queued" || recordStatus === "duplicate";
      if (saved) {
        recordedRunIdsRef.current.add(gameResult.runId);
        clearStoredCheckpoint();
      }
      if (updateUi && !unmountingRef.current) {
        const resultView = resultToView(
          gameResult,
          previousHighScoreRef.current,
          endedReason,
          recordStatus,
          unlockedAchievements,
        );
        setResult(resultView);
        statusRef.current = "over";
        setUiStatus("over");
        if (worldRef.current) setHud(worldToHud(worldRef.current));
        if (resultView.newRecord) {
          addToast({
            icon: "✦",
            kind: "record",
            title: copy.newRecord,
          });
        }
      }
      commandRef.current("GAME:PAUSE");
      if (playEndSound) {
        const isNewRecord = gameResult.score > previousHighScoreRef.current;
        emitSfxRef.current(
          isNewRecord
            ? "RECORD"
            : gameResult.outcome === "victory"
              ? "BOSS"
              : "OVER",
        );
      }
    },
    [
      addToast,
      clearStoredCheckpoint,
      copy.newRecord,
      finalizeRunAchievements,
      resetControls,
    ],
  );

  const finishActiveRun = useCallback(
    (endedReason: string, updateUi = true) => {
      const world = worldRef.current;
      if (!world || recordedRunIdsRef.current.has(world.runId)) return;
      finishWithResult(
        snapshotGameSummary(world),
        endedReason,
        updateUi,
        updateUi,
      );
    },
    [finishWithResult],
  );

  const retryResultSave = useCallback(() => {
    const world = worldRef.current;
    if (!world || !result || result.saved) return;
    finishWithResult(
      snapshotGameSummary(world),
      result.endedReason,
      true,
      false,
    );
  }, [finishWithResult, result]);

  useEffect(() => {
    finishActiveRunRef.current = finishActiveRun;
    saveSafeCheckpointRef.current = saveSafeCheckpoint;
  }, [finishActiveRun, saveSafeCheckpoint]);

  const toastForRuntimeEvent = useCallback(
    (id: GameToastId, value?: string | number) => {
      if (
        id === "power-collected" ||
        id === "power-ready" ||
        id === "power-cooldown" ||
        id === "power-low-energy" ||
        id === "power-not-needed"
      ) {
        const powerId = typeof value === "string" && value in copy.powers
          ? (value as PowerUpId)
          : hud.powerId;
        addToast({
          icon: "ϟ",
          kind:
            id === "power-collected"
              ? "power-collected"
              : id === "power-ready"
                ? "power-active"
                : id,
          subtitle:
            id === "power-collected" || id === "power-ready"
              ? copy.powers[powerId].description
              : undefined,
          title: copy.powers[powerId].name,
        });
      } else if (id === "sector-clear") {
        addToast({
          icon: "✓",
          kind: "sector",
          title: copy.sectors[hud.sector],
        });
      } else if (id === "elite-arrival" || id === "low-health") {
        addToast({ icon: "!", kind: "warning", title: copy.hud.danger });
      } else if (id === "victory") {
        addToast({ icon: "✦", kind: "boss", title: copy.victoryTitle });
      }
    },
    [addToast, copy, hud.powerId, hud.sector],
  );

  const handleEvents = useCallback(
    (events: readonly GameEvent[]) => {
      for (const event of events) {
        if (event.type === "sfx") {
          emitSfxRef.current(event.id);
        } else if (event.type === "toast") {
          toastForRuntimeEvent(event.id, event.value);
        } else if (event.type === "upgrade" && event.action === "offered") {
          resetControls();
          setUpgradeChoices([...event.choices]);
          if (worldRef.current) {
            setUpgradeStacks({ ...worldRef.current.upgradeStacks });
          }
          statusRef.current = "upgrade";
          setUiStatus("upgrade");
          saveSafeCheckpoint();
          commandRef.current("GAME:PAUSE");
        } else if (event.type === "boss") {
          if (event.action === "spawn") {
            addToast({ icon: "♛", kind: "warning", title: copy.hud.boss });
          } else if (event.action === "defeated") {
            addToast({ icon: "♛", kind: "boss", title: copy.bossDefeated });
          }
        } else if (event.type === "result") {
          finishWithResult(event.result, event.result.outcome, true, true);
        }
      }
    },
    [
      addToast,
      copy.bossDefeated,
      copy.hud.boss,
      finishWithResult,
      resetControls,
      saveSafeCheckpoint,
      toastForRuntimeEvent,
    ],
  );
  const handleEventsRef = useRef(handleEvents);

  useEffect(() => {
    handleEventsRef.current = handleEvents;
  }, [handleEvents]);

  const drawWorld = useCallback((world: GameWorld) => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    renderGameWorld(context, world, {
      reducedMotion: reducedMotionRef.current,
      screenShake: preferencesRef.current.screenShake,
    });
  }, []);

  useEffect(() => {
    if (uiStatus !== "playing") return;
    const tick = (timestamp: number) => {
      const world = worldRef.current;
      if (!world || statusRef.current !== "playing") return;
      const previous = lastFrameRef.current || timestamp;
      lastFrameRef.current = timestamp;

      const joystick = joystickRef.current;
      let physicalPowerPulse = false;
      if (connection === "connected" && joystick.pressed) {
        if (physicalPressStartedRef.current === null) {
          physicalPressStartedRef.current = timestamp;
          physicalPowerTriggeredRef.current = false;
        } else if (
          !physicalPowerTriggeredRef.current &&
          timestamp - physicalPressStartedRef.current >= 650
        ) {
          physicalPowerPulse = true;
          physicalPowerTriggeredRef.current = true;
        }
      } else {
        physicalPressStartedRef.current = null;
        physicalPowerTriggeredRef.current = false;
      }

      const input = resolveGameInput({
        centre: joystickCentreRef.current,
        invertY: preferencesRef.current.invertArduinoY,
        joystick: {
          connected: connection === "connected",
          pressed: joystick.pressed,
          x: joystick.x,
          y: joystick.y,
        },
        keyBindings: preferencesRef.current.keyBindings,
        keys: keyboardRef.current,
        touch: touchRef.current,
        virtualJoystick: virtualJoystickRef.current,
      });
      const events = stepGameWorld(
        world,
        { ...input, power: input.power || physicalPowerPulse },
        timestamp - previous,
      );
      drawWorld(world);
      if (timestamp - lastHudUpdateRef.current >= 80 || events.length > 0) {
        lastHudUpdateRef.current = timestamp;
        setHud(worldToHud(world));
        previewAchievementsRef.current(world);
      }
      handleEventsRef.current(events);
      if (statusRef.current === "playing") {
        animationRef.current = window.requestAnimationFrame(tick);
      }
    };
    lastFrameRef.current = performance.now();
    animationRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (animationRef.current !== null) {
        window.cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [connection, drawWorld, uiStatus]);

  useEffect(() => {
    if (uiStatus === "menu" || uiStatus === "playing") return;
    const world = worldRef.current;
    if (world) drawWorld(world);
  }, [drawWorld, uiStatus]);

  const pauseGame = useCallback(() => {
    if (statusRef.current !== "playing") return;
    resetControls();
    statusRef.current = "paused";
    setUiStatus("paused");
    commandRef.current("GAME:PAUSE");
  }, [resetControls]);

  const resumeGame = useCallback(() => {
    if (statusRef.current !== "paused") return;
    lastFrameRef.current = performance.now();
    statusRef.current = "playing";
    setUiStatus("playing");
    commandRef.current("GAME:RESUME");
  }, []);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (
        (event.code === "Escape" || event.code === "KeyP") &&
        !event.repeat
      ) {
        if (statusRef.current === "playing") pauseGame();
        else if (statusRef.current === "paused") resumeGame();
        if (statusRef.current !== "menu") event.preventDefault();
        return;
      }
      if (isNativeKeyboardControl(event.target)) return;
      if (statusRef.current !== "playing") return;
      const bindings = preferencesRef.current.keyBindings;
      if (
        Object.values(bindings).includes(event.code) ||
        event.code.startsWith("Arrow")
      ) {
        keyboardRef.current.add(event.code);
        event.preventDefault();
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      keyboardRef.current.delete(event.code);
    };
    const pauseForFocusLoss = () => pauseGame();
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") pauseGame();
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", pauseForFocusLoss);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", pauseForFocusLoss);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [pauseGame, resumeGame]);

  const startGame = useCallback(() => {
    if (
      !gameStats.profile ||
      !gameStats.profileOwnerId ||
      !isPlayableConnection(connection) ||
      resumeSnapshot ||
      (result && !result.saved)
    ) return;
    const runId = generateRunId();
    const world = createGameWorld(
      runId,
      mode,
      difficulty,
      `${runId}:${Date.now()}`,
    );
    previousHighScoreRef.current = gameStats.profile.highScore;
    achievementBaselineRef.current = createAchievementBaseline(
      gameStats.profile,
      gameStats.progression,
    );
    runAchievementIdsRef.current.clear();
    knownAchievementsRef.current = new Set(
      gameStats.progression?.achievements
        .filter((achievement) => achievement.unlockedAt !== null)
        .map((achievement) => achievement.achievementId) ?? [],
    );
    achievementWatchRef.current = true;
    void unlockAudioRef.current();
    resetControls();
    activeProfileOwnerRef.current = gameStats.profileOwnerId;
    worldRef.current = world;
    setResumeSnapshot(null);
    setResult(null);
    setCheckpointError(false);
    setToasts([]);
    setUpgradeChoices([]);
    setUpgradeStacks({});
    setHud(worldToHud(world));
    statusRef.current = "playing";
    setUiStatus("playing");
    lastFrameRef.current = performance.now();
    commandRef.current("GAME:1");
    commandRef.current(
      `GAME:SOUND:${
        preferencesRef.current.effectsVolume > 0 ||
        preferencesRef.current.musicVolume > 0
          ? 1
          : 0
      }`,
    );
    if (preferencesRef.current.musicVolume <= 0) {
      commandRef.current("TRACK:START");
      commandRef.current("TRACK:STOP");
    }
    commandRef.current(
      `SFX:VOLUME:${Math.round(preferencesRef.current.effectsVolume)}`,
    );
    drawWorld(world);
  }, [
    connection,
    difficulty,
    drawWorld,
    gameStats.profile,
    gameStats.profileOwnerId,
    gameStats.progression,
    mode,
    resetControls,
    result,
    resumeSnapshot,
  ]);

  const continueGame = useCallback(() => {
    if (
      !resumeSnapshot ||
      !gameStats.profile ||
      !gameStats.profileOwnerId ||
      resumeSnapshot.profileOwnerId !== gameStats.profileOwnerId ||
      !connected
    ) return;
    const world = restoreGameWorld(resumeSnapshot);
    previousHighScoreRef.current = gameStats.profile.highScore;
    achievementBaselineRef.current = createAchievementBaseline(
      gameStats.profile,
      gameStats.progression,
    );
    runAchievementIdsRef.current.clear();
    knownAchievementsRef.current = new Set(
      gameStats.progression?.achievements
        .filter((achievement) => achievement.unlockedAt !== null)
        .map((achievement) => achievement.achievementId) ?? [],
    );
    achievementWatchRef.current = true;
    void unlockAudioRef.current();
    resetControls();
    activeProfileOwnerRef.current = gameStats.profileOwnerId;
    worldRef.current = world;
    setMode(world.mode);
    setDifficulty(world.difficulty);
    setResult(null);
    setCheckpointError(false);
    setUpgradeChoices([...world.upgradeChoices]);
    setUpgradeStacks({ ...world.upgradeStacks });
    setHud(worldToHud(world));
    statusRef.current = "upgrade";
    setUiStatus("upgrade");
    commandRef.current("GAME:1");
    commandRef.current("GAME:PAUSE");
  }, [
    connected,
    gameStats.profile,
    gameStats.profileOwnerId,
    gameStats.progression,
    resetControls,
    resumeSnapshot,
  ]);

  const discardResume = useCallback(() => {
    clearStoredCheckpoint();
  }, [clearStoredCheckpoint]);

  const chooseUpgrade = useCallback(
    (upgrade: UpgradeId) => {
      const world = worldRef.current;
      if (checkpointError || !world || !selectUpgrade(world, upgrade)) return;
      resetControls();
      setUpgradeChoices([]);
      setUpgradeStacks({ ...world.upgradeStacks });
      setHud(worldToHud(world));
      statusRef.current = "playing";
      setUiStatus("playing");
      lastFrameRef.current = performance.now();
      commandRef.current("GAME:RESUME");
      drawWorld(world);
    },
    [checkpointError, drawWorld, resetControls],
  );

  const backToMenu = useCallback(() => {
    if (result && !result.saved) return;
    resetControls();
    activeProfileOwnerRef.current = null;
    achievementWatchRef.current = false;
    runAchievementIdsRef.current.clear();
    worldRef.current = null;
    setResult(null);
    setToasts([]);
    setUpgradeChoices([]);
    setUpgradeStacks({});
    statusRef.current = "menu";
    setUiStatus("menu");
    commandRef.current("GAME:0");
  }, [resetControls, result]);

  const manageUnsavedResult = useCallback(() => {
    if (!result || result.saved) return;
    resetControls();
    statusRef.current = "menu";
    setUiStatus("menu");
    commandRef.current("GAME:0");
  }, [resetControls, result]);

  const exportUnsavedResult = useCallback(() => {
    const world = worldRef.current;
    if (!world || !result || result.saved) return;
    const recovery = {
      exportedAt: new Date().toISOString(),
      kind: "space-defender-run-recovery",
      run: gameResultToStatsInput(
        snapshotGameSummary(world),
        result.endedReason,
      ),
      version: 1,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(recovery, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.download = `space-defender-recovery-${world.runId}.json`;
    link.href = url;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setResult((current) => current
      ? { ...current, recoveryExported: true }
      : current);
  }, [result]);

  const discardExportedResult = useCallback(() => {
    if (!result?.recoveryExported) return;
    if (!window.confirm(copy.discardRecoveryConfirm)) return;
    resetControls();
    achievementWatchRef.current = false;
    runAchievementIdsRef.current.clear();
    activeProfileOwnerRef.current = null;
    worldRef.current = null;
    setResult(null);
    setToasts([]);
    setUpgradeChoices([]);
    setUpgradeStacks({});
    statusRef.current = "menu";
    setUiStatus("menu");
    commandRef.current("GAME:0");
  }, [copy.discardRecoveryConfirm, resetControls, result?.recoveryExported]);

  const parkCheckpointInMenu = useCallback(() => {
    achievementWatchRef.current = false;
    statusRef.current = "menu";
    setUiStatus("menu");
  }, []);

  useEffect(() => {
    if (
      !isPlayableConnection(connection) &&
      (statusRef.current === "playing" || statusRef.current === "paused")
    ) {
      finishActiveRun("disconnected");
    } else if (
      !isPlayableConnection(connection) &&
      statusRef.current === "upgrade"
    ) {
      if (saveSafeCheckpoint()) {
        queueMicrotask(parkCheckpointInMenu);
      }
    }
  }, [connection, finishActiveRun, parkCheckpointInMenu, saveSafeCheckpoint]);

  useEffect(() => {
    const activeOwner = activeProfileOwnerRef.current;
    if (
      activeOwner &&
      gameStats.profileOwnerId !== activeOwner &&
      (statusRef.current === "playing" || statusRef.current === "paused")
    ) {
      finishActiveRun("profile-changed");
    } else if (
      activeOwner &&
      gameStats.profileOwnerId !== activeOwner &&
      statusRef.current === "upgrade"
    ) {
      if (saveSafeCheckpoint()) {
        queueMicrotask(parkCheckpointInMenu);
      }
    }
  }, [
    finishActiveRun,
    gameStats.profileOwnerId,
    parkCheckpointInMenu,
    saveSafeCheckpoint,
  ]);

  useEffect(() => {
    const unlocked = new Set(
      gameStats.progression?.achievements
        .filter((achievement) => achievement.unlockedAt !== null)
        .map((achievement) => achievement.achievementId) ?? [],
    );
    if (!achievementWatchRef.current) {
      knownAchievementsRef.current = unlocked;
      return;
    }
    const newlyConfirmed: GameAchievementId[] = [];
    for (const id of unlocked) {
      if (announceAchievement(id)) newlyConfirmed.push(id);
    }
    if (newlyConfirmed.length > 0) {
      queueMicrotask(() => {
        setResult((current) => current
          ? {
              ...current,
              unlockedAchievements: GAME_ACHIEVEMENTS
                .map((item) => item.id)
                .filter((id) =>
                  current.unlockedAchievements.includes(id) ||
                  newlyConfirmed.includes(id),
                ),
            }
          : current);
      });
    }
    knownAchievementsRef.current = new Set([
      ...knownAchievementsRef.current,
      ...unlocked,
    ]);
  }, [announceAchievement, gameStats.progression?.achievements]);

  useEffect(() => {
    const handlePageHide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      if (statusRef.current === "upgrade") saveSafeCheckpoint(false);
      else if (
        statusRef.current === "playing" ||
        statusRef.current === "paused"
      ) {
        finishActiveRun("pagehide", false);
      }
      commandRef.current("GAME:0");
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [finishActiveRun, saveSafeCheckpoint]);

  useEffect(() => {
    unmountingRef.current = false;
    return () => {
      unmountingRef.current = true;
      if (statusRef.current === "upgrade") saveSafeCheckpointRef.current(false);
      else if (
        statusRef.current === "playing" ||
        statusRef.current === "paused"
      ) {
        finishActiveRunRef.current("unmount", false);
      }
      commandRef.current("GAME:0");
    };
  }, []);

  const setTouchControl = useCallback(
    (
      control: "fire" | "power",
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
    },
    [],
  );

  const setAccessibleTouchControl = useCallback(
    (
      control: "fire" | "power",
      active: boolean,
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ) => {
      if (event.code !== "Space" && event.code !== "Enter") return;
      event.preventDefault();
      if (active) touchRef.current.add(control);
      else touchRef.current.delete(control);
    },
    [],
  );

  const updateVirtualJoystick = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (virtualPointerRef.current !== event.pointerId) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const radius = Math.max(24, Math.min(bounds.width, bounds.height) / 2 - 28);
      const rawX = (event.clientX - (bounds.left + bounds.width / 2)) / radius;
      const rawY = (event.clientY - (bounds.top + bounds.height / 2)) / radius;
      const length = Math.max(1, Math.hypot(rawX, rawY));
      const next = {
        active: true,
        x: Math.max(-1, Math.min(1, rawX / length)),
        y: Math.max(-1, Math.min(1, rawY / length)),
      };
      virtualJoystickRef.current = next;
      setVirtualJoystick(next);
    },
    [],
  );

  const startVirtualJoystick = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      virtualPointerRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      updateVirtualJoystick(event);
    },
    [updateVirtualJoystick],
  );

  const stopVirtualJoystick = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (virtualPointerRef.current !== event.pointerId) return;
      virtualPointerRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const reset = { active: false, x: 0, y: 0 };
      virtualJoystickRef.current = reset;
      setVirtualJoystick(reset);
    },
    [],
  );

  const achievementViews = useMemo<AchievementView[]>(
    () =>
      GAME_ACHIEVEMENTS.map((metadata) => {
        const progress = gameStats.progression?.achievements.find(
          (item) => item.achievementId === metadata.id,
        );
        return {
          description: copy.achievements[metadata.id].description,
          icon: ACHIEVEMENT_ICONS[metadata.icon] ?? "✦",
          id: metadata.id,
          name: copy.achievements[metadata.id].name,
          progress: progress?.progress ?? 0,
          rarity: metadata.rarity,
          target: metadata.target,
          unlockedAt: progress?.unlockedAt ?? null,
        };
      }),
    [copy.achievements, gameStats.progression?.achievements],
  );

  const careerStats = useMemo(() => {
    const totals = gameStats.progression?.totals;
    const favourite = [...(gameStats.progression?.powers ?? [])]
      .filter((power) => power.activatedCount > 0)
      .sort(
        (left, right) =>
          right.activatedCount - left.activatedCount ||
          left.powerId.localeCompare(right.powerId),
      )[0];
    return {
      accuracy:
        totals?.shotsFired
          ? Math.min(1, totals.shotsHit / totals.shotsFired)
          : 0,
      bossesDefeated: totals?.bossesDefeated ?? 0,
      enemiesDestroyed: totals?.enemiesDestroyed ?? 0,
      favouritePower: favourite
        ? copy.powers[favourite.powerId].name
        : "",
      longestCombo: totals?.longestCombo ?? 0,
      longestRunSeconds: (totals?.longestRunMs ?? 0) / 1_000,
      powerupsCollected: totals?.powerupsCollected ?? 0,
      unlockedAchievements:
        gameStats.progression?.achievements.filter(
          (achievement) => achievement.unlockedAt !== null,
        ).length ?? 0,
    };
  }, [copy.powers, gameStats.progression]);

  const bestWave = Math.max(
    gameStats.profile?.highestLevel ?? 0,
    ...(gameStats.progression?.modes.map((entry) => entry.highestWave) ?? [0]),
  );
  const connectionLabel =
    connection === "connected"
      ? copy.controllerArduino
      : connection === "demo"
        ? copy.controllerDemo
        : legacyCopy.noConnection;
  const knobX = virtualJoystick.active
    ? virtualJoystick.x
    : connection === "connected"
      ? Math.max(-1, Math.min(1, (joystickX - joystickCentre.x) / 420))
      : 0;
  const rawKnobY = Math.max(
    -1,
    Math.min(1, (joystickY - joystickCentre.y) / 420),
  );
  const knobY = virtualJoystick.active
    ? virtualJoystick.y
    : connection === "connected"
      ? preferences.invertArduinoY
        ? rawKnobY
        : -rawKnobY
      : 0;
  const calibrateJoystick = () => {
    setJoystickCentre({
      x: Math.round(joystickX),
      y: Math.round(joystickY),
    });
  };

  return (
    <section className="game-tab" id="game">
      <div className="game-intro">
        <div>
          <p className="eyebrow">{legacyCopy.introEyebrow}</p>
          <h1>{legacyCopy.title}</h1>
          <p>{legacyCopy.intro}</p>
        </div>
        <div className="game-legend">
          <span>
            <kbd>
              {displayGameKey(preferences.keyBindings.moveUp)}·
              {displayGameKey(preferences.keyBindings.moveLeft)}·
              {displayGameKey(preferences.keyBindings.moveDown)}·
              {displayGameKey(preferences.keyBindings.moveRight)}
            </kbd>{" "}{legacyCopy.move}
          </span>
          <span><kbd>{displayGameKey(preferences.keyBindings.fire)}</kbd> {legacyCopy.fire}</span>
          <span><kbd>{displayGameKey(preferences.keyBindings.power)}</kbd> {copy.activatePower}</span>
        </div>
      </div>

      <div
        className="space-game-root"
        data-reduced-motion={effectiveMotionReduction ? "true" : "false"}
      >
        {uiStatus === "menu" ? (
          <>
            {!connected && (
              <aside
                aria-busy={connection === "connecting"}
                className="space-connect-panel"
              >
                <div>
                  <strong>{legacyCopy.connectFirst}</strong>
                  <p>{legacyCopy.demoHint}</p>
                  {error && <p className="error-message game-error">{error}</p>}
                </div>
                <div>
                  {isSupported && (
                    <button
                      className="button primary"
                      disabled={connection === "connecting"}
                      onClick={onConnect}
                      type="button"
                    >
                      {legacyCopy.connectArduino}
                    </button>
                  )}
                  <button
                    className="button secondary"
                    disabled={connection === "connecting"}
                    onClick={onStartDemo}
                    type="button"
                  >
                    {isSupported ? legacyCopy.demoWithoutBoard : legacyCopy.startDemo}
                  </button>
                </div>
              </aside>
            )}

            {connection === "connected" && (
              <aside className="space-connect-panel space-calibration-panel">
                <div>
                  <strong>{copy.controllerArduino}</strong>
                  <p>{legacyCopy.calibration(joystickX, joystickY)}</p>
                </div>
                <button
                  className="button secondary"
                  onClick={calibrateJoystick}
                  type="button"
                >
                  {legacyCopy.calibrate}
                </button>
              </aside>
            )}

            <GameMenu
              achievementsPanel={(
                <AchievementGallery achievements={achievementViews} copy={copy} />
              )}
              bestScore={gameStats.profile?.highScore ?? 0}
              bestWave={bestWave}
              checkpointError={checkpointError}
              connected={connected}
              connectionLabel={connectionLabel}
              copy={copy}
              difficulty={difficulty}
              hasProfile={Boolean(gameStats.profile)}
              hasResume={Boolean(resumeSnapshot)}
              hasUnsavedResult={Boolean(result && !result.saved)}
              hardwareAudio={connection === "connected"}
              leaderboardPanel={(
                <LeaderboardPanel
                  copy={legacyCopy}
                  language={language}
                  stats={gameStats}
                />
              )}
              mode={mode}
              onContinue={continueGame}
              onConfirm={() => emitSfxRef.current("MENU")}
              onDifficultyChange={setDifficulty}
              onDiscardResume={discardResume}
              onModeChange={setMode}
              onPreferencesChange={setPreferences}
              onRetryUnsavedResult={retryResultSave}
              onStart={startGame}
              preferences={preferences}
              resumeCompatible={Boolean(
                resumeSnapshot?.profileOwnerId &&
                resumeSnapshot.profileOwnerId === gameStats.profileOwnerId
              )}
              resumeSummary={resumeSnapshot
                ? {
                    difficulty: resumeSnapshot.run.difficulty,
                    equippedPower: resumeSnapshot.run.equippedPowerUp,
                    mode: resumeSnapshot.run.mode,
                    upgrades: (Object.entries(resumeSnapshot.run.upgradeStacks) as Array<[
                      UpgradeId,
                      number,
                    ]>)
                      .filter(([, stacks]) => stacks > 0)
                      .map(([id, stacks]) => ({ id, stacks })),
                    wave: resumeSnapshot.run.wave,
                  }
                : null}
              profilePanel={(
                <PlayerStatsPanel
                  copy={legacyCopy}
                  language={language}
                  stats={gameStats}
                />
              )}
              startingPowers={[copy.powers.shield.name]}
              statisticsPanel={(
                <CareerStats
                  copy={copy}
                  modes={gameStats.progression?.modes ?? []}
                  stats={careerStats}
                />
              )}
            />
          </>
        ) : (
          <>
            <div className="space-stage-shell" data-sector={hud.sector}>
              <GameHud
                bossHealth={hud.bossHealth}
                bossMaxHealth={hud.bossMaxHealth}
                bossPhase={hud.bossPhase}
                combo={hud.combo}
                copy={copy}
                energy={hud.energy}
                lives={hud.lives}
                maxLives={hud.maxLives}
                maxShield={hud.maxShield}
                phase={hud.phase}
                powerActiveRemaining={hud.powerActiveRemaining}
                powerCooldown={hud.powerCooldown}
                powerEnergyCost={hud.powerEnergyCost}
                powerName={copy.powers[hud.powerId].name}
                score={hud.score}
                sectorName={copy.sectors[hud.sector]}
                shield={hud.shield}
                upgrades={hud.upgrades}
                wave={hud.wave}
              />
              <div className="space-canvas-wrap">
                <canvas
                  aria-label={legacyCopy.canvasAria}
                  height={540}
                  onPointerDown={() => canvasRef.current?.focus()}
                  ref={canvasRef}
                  tabIndex={0}
                  width={900}
                />
                <GameToastStack copy={copy} toasts={toasts} />
                <GameOverlay
                  canPlayAgain={
                    connected &&
                    Boolean(result?.saved) &&
                    !checkpointError &&
                    !resumeSnapshot
                  }
                  checkpointError={checkpointError}
                  copy={copy}
                  onBackToMenu={backToMenu}
                  onDiscardUnsavedResult={discardExportedResult}
                  onExportRecovery={exportUnsavedResult}
                  onFinish={() => finishActiveRun("stopped")}
                  onManageSave={manageUnsavedResult}
                  onPlayAgain={startGame}
                  onRetryCheckpoint={() => saveSafeCheckpoint()}
                  onRetrySave={retryResultSave}
                  onResume={resumeGame}
                  onSelectUpgrade={(upgrade) => chooseUpgrade(upgrade)}
                  result={result}
                  status={uiStatus}
                  upgradeChoices={upgradeChoices}
                  upgradeStacks={upgradeStacks}
                />
              </div>
              <div className="space-stage-toolbar">
                <button
                  className="button secondary"
                  disabled={uiStatus !== "playing"}
                  onClick={pauseGame}
                  type="button"
                >
                  {legacyCopy.pause}
                </button>
                <span>{connectionLabel}</span>
                {connection === "connected" && (
                  <button
                    className="button secondary"
                    onClick={calibrateJoystick}
                    type="button"
                  >
                    {legacyCopy.calibrate}
                  </button>
                )}
              </div>
            </div>

            {uiStatus === "playing" && (
              <div className="space-touch-deck">
                <div
                  aria-label={legacyCopy.touchJoystickAria}
                  className={`space-virtual-stick ${virtualJoystick.active ? "is-active" : ""}`}
                  onPointerCancel={stopVirtualJoystick}
                  onPointerDown={startVirtualJoystick}
                  onLostPointerCapture={stopVirtualJoystick}
                  onPointerMove={updateVirtualJoystick}
                  onPointerUp={stopVirtualJoystick}
                  role="group"
                >
                  <i />
                  <span
                    style={{
                      transform: `translate(calc(-50% + ${knobX * 48}px), calc(-50% + ${knobY * 48}px))`,
                    }}
                  >
                    SW
                  </span>
                </div>
                <div className="space-touch-actions">
                  <button
                    aria-label={legacyCopy.fire}
                    className="space-fire-button"
                    onBlur={() => touchRef.current.delete("fire")}
                    onKeyDown={(event) => setAccessibleTouchControl("fire", true, event)}
                    onKeyUp={(event) => setAccessibleTouchControl("fire", false, event)}
                    onLostPointerCapture={(event) => setTouchControl("fire", false, event)}
                    onPointerCancel={(event) => setTouchControl("fire", false, event)}
                    onPointerDown={(event) => setTouchControl("fire", true, event)}
                    onPointerUp={(event) => setTouchControl("fire", false, event)}
                    type="button"
                  >
                    {legacyCopy.fire.toUpperCase()}<small>{legacyCopy.fire}</small>
                  </button>
                  <button
                    aria-label={copy.activatePower}
                    className="space-power-button"
                    onBlur={() => touchRef.current.delete("power")}
                    onKeyDown={(event) => setAccessibleTouchControl("power", true, event)}
                    onKeyUp={(event) => setAccessibleTouchControl("power", false, event)}
                    onLostPointerCapture={(event) => setTouchControl("power", false, event)}
                    onPointerCancel={(event) => setTouchControl("power", false, event)}
                    onPointerDown={(event) => setTouchControl("power", true, event)}
                    onPointerUp={(event) => setTouchControl("power", false, event)}
                    type="button"
                  >
                    ϟ<small>{copy.activatePower}</small>
                  </button>
                </div>
              </div>
            )}
            <p className="space-keyboard-hint">
              {formatGameControlSummary(copy, preferences)}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
