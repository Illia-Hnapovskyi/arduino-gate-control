"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import type { SpaceDefenderCopy } from "../i18n";
import type { PowerUpId, UpgradeId } from "./types";
import {
  DEFAULT_GAME_KEY_BINDINGS,
  rebindGameAction,
  type GameAction,
  type GamePreferences,
} from "./preferences";

export type GameMenuSection =
  | "play"
  | "profile"
  | "achievements"
  | "stats"
  | "leaderboard"
  | "settings"
  | "controls"
  | "tutorial"
  | "arduino";

export type GameModeId = "expedition" | "survival" | "classic";
export type GameDifficultyId = "cadet" | "pilot" | "ace";

type GameMenuProps = {
  achievementsPanel: ReactNode;
  bestScore: number;
  bestWave: number;
  checkpointError: boolean;
  connected: boolean;
  connectionLabel: string;
  copy: SpaceDefenderCopy;
  difficulty: GameDifficultyId;
  hasProfile: boolean;
  hasResume: boolean;
  hasUnsavedResult: boolean;
  hardwareAudio: boolean;
  leaderboardPanel: ReactNode;
  mode: GameModeId;
  onContinue: () => void;
  onConfirm: () => void;
  onDifficultyChange: (difficulty: GameDifficultyId) => void;
  onDiscardResume: () => void;
  onModeChange: (mode: GameModeId) => void;
  onPreferencesChange: (preferences: GamePreferences) => void;
  onRetryUnsavedResult: () => void;
  onStart: () => void;
  preferences: GamePreferences;
  profilePanel: ReactNode;
  resumeCompatible: boolean;
  resumeSummary: {
    difficulty: GameDifficultyId;
    equippedPower: PowerUpId;
    mode: GameModeId;
    upgrades: readonly { id: UpgradeId; stacks: number }[];
    wave: number;
  } | null;
  startingPowers: readonly string[];
  statisticsPanel: ReactNode;
};

const MENU_SECTIONS: readonly GameMenuSection[] = [
  "play",
  "profile",
  "achievements",
  "stats",
  "leaderboard",
  "settings",
  "controls",
  "tutorial",
  "arduino",
];

const MODE_IDS: readonly GameModeId[] = ["expedition", "survival", "classic"];
const DIFFICULTY_IDS: readonly GameDifficultyId[] = ["cadet", "pilot", "ace"];

const ACTION_LABEL_KEYS: Record<GameAction, keyof Pick<
  SpaceDefenderCopy,
  "keyMoveUp" | "keyMoveDown" | "keyMoveLeft" | "keyMoveRight" | "keyFire" | "keyPower"
>> = {
  moveUp: "keyMoveUp",
  moveDown: "keyMoveDown",
  moveLeft: "keyMoveLeft",
  moveRight: "keyMoveRight",
  fire: "keyFire",
  power: "keyPower",
};

export function displayGameKey(code: string) {
  return code
    .replace(/^Key/, "")
    .replace(/^Digit/, "")
    .replace(/^Arrow/, "")
    .replace(/Left$|Right$/, "")
    .toUpperCase();
}

export function formatGameControlSummary(
  copy: SpaceDefenderCopy,
  preferences: GamePreferences,
) {
  return copy.formatControls(
    displayGameKey(preferences.keyBindings.moveUp),
    displayGameKey(preferences.keyBindings.moveDown),
    displayGameKey(preferences.keyBindings.moveLeft),
    displayGameKey(preferences.keyBindings.moveRight),
    displayGameKey(preferences.keyBindings.fire),
    displayGameKey(preferences.keyBindings.power),
  );
}

export function GameMenu({
  achievementsPanel,
  bestScore,
  bestWave,
  checkpointError,
  connected,
  connectionLabel,
  copy,
  difficulty,
  hasProfile,
  hasResume,
  hasUnsavedResult,
  hardwareAudio,
  leaderboardPanel,
  mode,
  onContinue,
  onConfirm,
  onDifficultyChange,
  onDiscardResume,
  onModeChange,
  onPreferencesChange,
  onRetryUnsavedResult,
  onStart,
  preferences,
  profilePanel,
  resumeCompatible,
  resumeSummary,
  startingPowers,
  statisticsPanel,
}: GameMenuProps) {
  const [section, setSection] = useState<GameMenuSection>("play");
  const [bindingAction, setBindingAction] = useState<GameAction | null>(null);
  const menuTitleRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    menuTitleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!bindingAction) return;
    const captureKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === "Escape") {
        setBindingAction(null);
        return;
      }
      onPreferencesChange({
        ...preferences,
        keyBindings: rebindGameAction(
          preferences.keyBindings,
          bindingAction,
          event.code,
        ),
      });
      setBindingAction(null);
    };
    window.addEventListener("keydown", captureKey, { capture: true });
    return () => window.removeEventListener("keydown", captureKey, { capture: true });
  }, [bindingAction, onPreferencesChange, preferences]);

  const updatePreference = <Key extends keyof GamePreferences>(
    key: Key,
    value: GamePreferences[Key],
  ) => onPreferencesChange({ ...preferences, [key]: value });

  const controlsSummary = formatGameControlSummary(copy, preferences);
  const preflightMode = resumeSummary?.mode ?? mode;
  const preflightDifficulty = resumeSummary?.difficulty ?? difficulty;
  const preflightPowers = resumeSummary
    ? [
        copy.powers[resumeSummary.equippedPower].name,
        ...resumeSummary.upgrades.map(
          (upgrade) =>
            `${copy.upgrades[upgrade.id].name} ×${copy.formatNumber(upgrade.stacks)}`,
        ),
      ]
    : startingPowers;

  return (
    <section aria-labelledby="space-defender-menu-title" className="space-menu-shell">
      <header className="space-menu-header">
        <div>
          <span className="game-kicker">{copy.menuKicker}</span>
          <h2 id="space-defender-menu-title" ref={menuTitleRef} tabIndex={-1}>
            {copy.menuTitle}
          </h2>
          <p>{copy.menuSubtitle}</p>
        </div>
        <span className={`space-controller-badge ${connected ? "is-online" : ""}`}>
          <i aria-hidden="true" /> {connectionLabel}
        </span>
      </header>

      <nav aria-label={copy.menuTitle} className="space-menu-nav">
        {MENU_SECTIONS.map((item) => (
          <button
            aria-current={section === item ? "page" : undefined}
            className={section === item ? "is-active" : ""}
            key={item}
            onClick={() => {
              onConfirm();
              setSection(item);
            }}
            type="button"
          >
            {copy.menuSections[item]}
          </button>
        ))}
      </nav>

      {hasUnsavedResult && (
        <aside className="space-unsaved-result" role="alert">
          <div>
            <strong>{copy.unsavedResultTitle}</strong>
            <p>{copy.unsavedResultRecovery}</p>
          </div>
          <button className="button primary" onClick={onRetryUnsavedResult} type="button">
            {copy.retrySave}
          </button>
        </aside>
      )}

      {checkpointError && (
        <aside className="space-unsaved-result" role="alert">
          <div>
            <strong>{copy.savedRunTitle}</strong>
            <p>{copy.checkpointClearFailed}</p>
          </div>
        </aside>
      )}

      <div className="space-menu-panel">
        {section === "play" && (
          <div className="space-preflight">
            <div className="space-choice-group">
              <h3>{copy.modeLabel}</h3>
              <div className="space-choice-grid mode-grid">
                {MODE_IDS.map((id) => (
                  <button
                    aria-pressed={preflightMode === id}
                    className={preflightMode === id ? "is-selected" : ""}
                    disabled={hasResume}
                    key={id}
                    onClick={() => {
                      onConfirm();
                      onModeChange(id);
                    }}
                    type="button"
                  >
                    <strong>{copy.modes[id].name}</strong>
                    <span>{copy.modes[id].description}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-choice-group">
              <h3>{copy.difficultyLabel}</h3>
              <div className="space-choice-grid difficulty-grid">
                {DIFFICULTY_IDS.map((id) => (
                  <button
                    aria-pressed={preflightDifficulty === id}
                    className={preflightDifficulty === id ? "is-selected" : ""}
                    disabled={hasResume}
                    key={id}
                    onClick={() => {
                      onConfirm();
                      onDifficultyChange(id);
                    }}
                    type="button"
                  >
                    <strong>{copy.difficulties[id].name}</strong>
                    <span>{copy.difficulties[id].description}</span>
                  </button>
                ))}
              </div>
            </div>

            <aside className="space-preflight-card">
              <h3>{resumeSummary ? copy.savedRunTitle : copy.preflightTitle}</h3>
              <dl>
                <div><dt>{copy.modeLabel}</dt><dd>{copy.modes[preflightMode].name}</dd></div>
                <div><dt>{copy.difficultyLabel}</dt><dd>{copy.difficulties[preflightDifficulty].name}</dd></div>
                {resumeSummary && (
                  <div><dt>{copy.hud.wave}</dt><dd>{copy.formatNumber(resumeSummary.wave)}</dd></div>
                )}
                <div><dt>{copy.bestScore}</dt><dd>{copy.formatNumber(bestScore)}</dd></div>
                <div><dt>{copy.bestWave}</dt><dd>{copy.formatNumber(bestWave)}</dd></div>
                <div><dt>{copy.controller}</dt><dd>{connectionLabel}</dd></div>
                <div>
                  <dt>{copy.activeUpgrades}</dt>
                  <dd>{preflightPowers.length ? preflightPowers.join(" · ") : "—"}</dd>
                </div>
              </dl>
              {!hasProfile && <p className="space-menu-warning">{copy.profileNeeded}</p>}
              {!connected && <p className="space-menu-warning">{copy.connectionNeeded}</p>}
              {hasResume && !resumeCompatible && (
                <p className="space-menu-warning" role="alert">
                  {copy.resumeProfileMismatch}
                </p>
              )}
              <p className="space-offline-note">{copy.offlineNote}</p>
              <div className="space-launch-actions">
                {hasResume && (
                  <>
                    <button
                      className="button primary"
                      disabled={!resumeCompatible || !connected || !hasProfile}
                      onClick={() => {
                        onConfirm();
                        onContinue();
                      }}
                      type="button"
                    >
                      {copy.continueRun}
                    </button>
                    <button className="button secondary" onClick={() => {
                      onConfirm();
                      onDiscardResume();
                    }} type="button">
                      {copy.discardRun}
                    </button>
                  </>
                )}
                <button
                  className="button game-start"
                  disabled={hasResume || hasUnsavedResult || !connected || !hasProfile}
                  onClick={() => {
                    onConfirm();
                    onStart();
                  }}
                  type="button"
                >
                  {copy.startRun}
                </button>
              </div>
            </aside>
          </div>
        )}

        {section === "profile" && profilePanel}
        {section === "achievements" && achievementsPanel}
        {section === "stats" && statisticsPanel}
        {section === "leaderboard" && leaderboardPanel}

        {section === "settings" && (
          <div className="space-settings-panel">
            <h3>{copy.settingsTitle}</h3>
            <label>
              <span>{copy.musicVolume}</span>
              <output>{preferences.musicVolume}%</output>
              <input
                max="100"
                min="0"
                onChange={(event) => updatePreference("musicVolume", Number(event.target.value))}
                type="range"
                value={preferences.musicVolume}
              />
              {hardwareAudio && (
                <small className="space-hardware-audio-note">
                  {copy.hardwareMusicNote}
                </small>
              )}
            </label>
            <label>
              <span>{copy.effectsVolume}</span>
              <output>{preferences.effectsVolume}%</output>
              <input
                max="100"
                min="0"
                onChange={(event) => updatePreference("effectsVolume", Number(event.target.value))}
                type="range"
                value={preferences.effectsVolume}
              />
            </label>
            <label className="space-toggle-row">
              <input
                checked={preferences.screenShake}
                onChange={(event) => updatePreference("screenShake", event.target.checked)}
                type="checkbox"
              />
              <span>{copy.screenShake}</span>
            </label>
            <label className="space-toggle-row">
              <input
                checked={preferences.reducedMotion}
                onChange={(event) => updatePreference("reducedMotion", event.target.checked)}
                type="checkbox"
              />
              <span>{copy.reducedMotion}</span>
            </label>
            <label className="space-toggle-row">
              <input
                checked={preferences.invertArduinoY}
                onChange={(event) => updatePreference("invertArduinoY", event.target.checked)}
                type="checkbox"
              />
              <span>{copy.invertArduinoY}</span>
            </label>

            <div className="space-key-bindings">
              <h4>{copy.keyBindings}</h4>
              {Object.entries(ACTION_LABEL_KEYS).map(([action, labelKey]) => (
                <button
                  className={bindingAction === action ? "is-listening" : ""}
                  key={action}
                  onClick={() => setBindingAction(action as GameAction)}
                  type="button"
                >
                  <span>{copy[labelKey]}</span>
                  <kbd>{bindingAction === action ? "…" : displayGameKey(preferences.keyBindings[action as GameAction])}</kbd>
                </button>
              ))}
              <button
                className="space-reset-keys"
                onClick={() => updatePreference("keyBindings", { ...DEFAULT_GAME_KEY_BINDINGS })}
                type="button"
              >
                {copy.resetKeys}
              </button>
            </div>
          </div>
        )}

        {section === "controls" && (
          <article className="space-info-panel">
            <span aria-hidden="true" className="space-info-icon">⌁</span>
            <div><h3>{copy.controlsTitle}</h3><p>{controlsSummary}</p></div>
          </article>
        )}

        {section === "tutorial" && (
          <div className="space-tutorial-panel">
            <h3>{copy.tutorialTitle}</h3>
            <ol>{copy.tutorialSteps.map((step) => <li key={step}>{step}</li>)}</ol>
          </div>
        )}

        {section === "arduino" && (
          <article className="space-info-panel arduino-info">
            <span aria-hidden="true" className="space-info-icon">A0</span>
            <div><h3>{copy.arduinoTitle}</h3><p>{copy.arduinoText}</p></div>
          </article>
        )}
      </div>
    </section>
  );
}
