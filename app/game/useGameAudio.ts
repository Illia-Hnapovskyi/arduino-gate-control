"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  createBrowserAudioEngine,
  type GameSfxId,
  getSectorAudio,
  getTrack,
  scheduleBrowserTrackStep,
} from "./audio";
import type { GamePreferences } from "./preferences";
import type { SectorId } from "./types";

type AudioConnection = "disconnected" | "connecting" | "connected" | "demo";
type AudioGameState = "menu" | "playing" | "paused" | "upgrade" | "over";

export function useGameAudio({
  bossActive,
  connection,
  onCommand,
  preferences,
  sector,
  state,
}: {
  bossActive: boolean;
  connection: AudioConnection;
  onCommand: (command: string) => void;
  preferences: GamePreferences;
  sector: SectorId;
  state: AudioGameState;
}) {
  const commandRef = useRef(onCommand);
  const preferencesRef = useRef(preferences);
  const connectionRef = useRef(connection);
  const stateRef = useRef(state);
  const browserEngineRef = useRef(createBrowserAudioEngine());
  const browserTimerRef = useRef<number | null>(null);
  const browserBusRef = useRef<GainNode | null>(null);
  const browserStepRef = useRef(0);
  const browserNextTimeRef = useRef(0);
  const serialTimerRef = useRef<number | null>(null);
  const serialStepRef = useRef(0);

  useEffect(() => {
    commandRef.current = onCommand;
  }, [onCommand]);
  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);
  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const stopBrowserMusic = useCallback(() => {
    if (browserTimerRef.current !== null) {
      window.clearInterval(browserTimerRef.current);
      browserTimerRef.current = null;
    }
    const context = browserEngineRef.current.ensureContext();
    const bus = browserBusRef.current;
    browserBusRef.current = null;
    if (context && bus) {
      const now = context.currentTime;
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), now);
      bus.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
      window.setTimeout(() => bus.disconnect(), 70);
    }
  }, []);

  const stopSerialMusic = useCallback((notify = true) => {
    if (serialTimerRef.current !== null) {
      window.clearTimeout(serialTimerRef.current);
      serialTimerRef.current = null;
    }
    if (notify && connectionRef.current === "connected") {
      commandRef.current("TRACK:STOP");
    }
  }, []);

  const stopMusic = useCallback(() => {
    stopBrowserMusic();
    stopSerialMusic();
  }, [stopBrowserMusic, stopSerialMusic]);

  const startBrowserMusic = useCallback((activeSector: SectorId) => {
    const engine = browserEngineRef.current;
    const context = engine.ensureContext();
    if (!context || preferencesRef.current.musicVolume <= 0) return;
    void engine.resume();
    const profile = getSectorAudio(activeSector);
    const track = getTrack(profile.trackId);
    const bus = context.createGain();
    bus.gain.setValueAtTime(
      Math.max(0.0001, preferencesRef.current.musicVolume / 210),
      context.currentTime,
    );
    bus.connect(context.destination);
    browserBusRef.current = bus;
    browserNextTimeRef.current = context.currentTime + 0.035;

    const scheduleAhead = () => {
      if (stateRef.current !== "playing") return;
      while (browserNextTimeRef.current < context.currentTime + 0.42) {
        const duration = scheduleBrowserTrackStep(
          context,
          bus,
          track,
          browserStepRef.current,
          browserNextTimeRef.current,
          profile,
        );
        browserStepRef.current += 1;
        browserNextTimeRef.current += duration;
      }
    };
    scheduleAhead();
    browserTimerRef.current = window.setInterval(scheduleAhead, 110);
  }, []);

  const startSerialMusic = useCallback((activeSector: SectorId) => {
    commandRef.current("TRACK:START");
    if (preferencesRef.current.musicVolume <= 0) {
      commandRef.current("TRACK:STOP");
      return;
    }
    const profile = getSectorAudio(activeSector);
    const track = getTrack(profile.trackId);

    const next = () => {
      if (
        connectionRef.current !== "connected" ||
        stateRef.current !== "playing" ||
        preferencesRef.current.musicVolume <= 0
      ) {
        serialTimerRef.current = null;
        return;
      }
      const step = serialStepRef.current % track.notes.length;
      const baseSeconds =
        (60 / track.bpm / 2) * (track.stepMultiplier ?? 1) /
        profile.tempoMultiplier;
      const stepSeconds = track.notes[step] === 0 ? baseSeconds * 0.55 : baseSeconds;
      const duration = Math.max(20, Math.min(1000, Math.round(stepSeconds * 820)));
      commandRef.current(`TRACK:TONE:${track.notes[step]}:${duration}`);
      serialStepRef.current += 1;
      serialTimerRef.current = window.setTimeout(next, Math.round(stepSeconds * 1000));
    };
    next();
  }, []);

  useEffect(() => {
    stopBrowserMusic();
    stopSerialMusic(false);
    if (state !== "playing") return;
    browserStepRef.current = 0;
    serialStepRef.current = 0;
    const musicSector = bossActive ? "boss" : sector;
    if (connection === "demo") startBrowserMusic(musicSector);
    if (connection === "connected") startSerialMusic(musicSector);
    return stopMusic;
  }, [
    connection,
    bossActive,
    preferences.musicVolume,
    sector,
    startBrowserMusic,
    startSerialMusic,
    state,
    stopBrowserMusic,
    stopMusic,
    stopSerialMusic,
  ]);

  useEffect(() => {
    const browserEngine = browserEngineRef.current;
    return () => {
      stopBrowserMusic();
      stopSerialMusic(false);
      void browserEngine.close();
    };
  }, [stopBrowserMusic, stopSerialMusic]);

  const emitSfx = useCallback((effect: GameSfxId) => {
    if (preferencesRef.current.effectsVolume <= 0) return;
    if (connectionRef.current === "demo") {
      browserEngineRef.current.playEffect(
        effect,
        preferencesRef.current.effectsVolume,
      );
    } else if (connectionRef.current === "connected") {
      commandRef.current(`SFX:${effect}`);
    }
  }, []);

  const unlockAudio = useCallback(
    () => browserEngineRef.current.resume(),
    [],
  );

  return { emitSfx, stopMusic, unlockAudio };
}
