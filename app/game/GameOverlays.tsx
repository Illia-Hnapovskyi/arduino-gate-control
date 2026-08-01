import { useEffect, useRef } from "react";
import type { SpaceDefenderCopy } from "../i18n";
import type { GameRunRecordResult } from "../useGameStats";
import type { GameAchievementId } from "../../shared/gameStats";
import { UPGRADE_BALANCE } from "./balance";
import type { UpgradeStacks } from "./types";

export type PowerChoiceId = keyof SpaceDefenderCopy["upgrades"];

export type RunResultView = {
  accuracy: number;
  bosses: number;
  durationSeconds: number;
  endedReason: string;
  enemies: number;
  longestCombo: number;
  newRecord: boolean;
  recoveryExported: boolean;
  unlockedAchievements: GameAchievementId[];
  saveStatus: GameRunRecordResult;
  saved: boolean;
  score: number;
  victory: boolean;
  wave: number;
};

type GameOverlayProps = {
  canPlayAgain: boolean;
  checkpointError: boolean;
  copy: SpaceDefenderCopy;
  onBackToMenu: () => void;
  onDiscardUnsavedResult: () => void;
  onExportRecovery: () => void;
  onFinish: () => void;
  onManageSave: () => void;
  onPlayAgain: () => void;
  onRetryCheckpoint: () => void;
  onRetrySave: () => void;
  onResume: () => void;
  onSelectUpgrade: (power: PowerChoiceId) => void;
  result: RunResultView | null;
  status: "playing" | "paused" | "upgrade" | "over";
  upgradeChoices: readonly PowerChoiceId[];
  upgradeStacks: UpgradeStacks;
};

export function GameOverlay({
  canPlayAgain,
  checkpointError,
  copy,
  onBackToMenu,
  onDiscardUnsavedResult,
  onExportRecovery,
  onFinish,
  onManageSave,
  onPlayAgain,
  onRetryCheckpoint,
  onRetrySave,
  onResume,
  onSelectUpgrade,
  result,
  status,
  upgradeChoices,
  upgradeStacks,
}: GameOverlayProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (status === "playing") {
      if (previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus();
      }
      previousFocusRef.current = null;
      return;
    }

    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!previousFocusRef.current && document.activeElement instanceof HTMLElement) {
      previousFocusRef.current = document.activeElement;
    }

    const focusableSelector = [
      "button:not([disabled])",
      "[href]",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const focusables = () =>
      Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (element) => !element.hasAttribute("hidden"),
      );
    const initialFocus =
      dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]") ??
      focusables()[0] ??
      dialog;
    initialFocus.focus();

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const available = focusables();
      if (!available.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = available[0];
      const last = available[available.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", trapFocus);
    return () => dialog.removeEventListener("keydown", trapFocus);
  }, [result, status, upgradeChoices]);

  useEffect(
    () => () => {
      if (previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus();
      }
    },
    [],
  );

  if (status === "playing") return null;

  if (status === "paused") {
    return (
      <div
        aria-describedby="space-pause-description"
        aria-labelledby="space-pause-title"
        aria-modal="true"
        className="space-game-overlay"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="space-overlay-card pause-card">
          <span aria-hidden="true" className="space-overlay-symbol">Ⅱ</span>
          <h2 id="space-pause-title">{copy.pauseTitle}</h2>
          <p id="space-pause-description">{copy.pauseHint}</p>
          <div>
            <button autoFocus className="button primary" data-dialog-initial-focus onClick={onResume} type="button">{copy.resume}</button>
            <button className="button secondary" onClick={onFinish} type="button">{copy.finishRun}</button>
          </div>
        </div>
      </div>
    );
  }

  if (status === "upgrade") {
    return (
      <div
        aria-describedby="space-upgrade-description"
        aria-labelledby="space-upgrade-title"
        aria-modal="true"
        className="space-game-overlay upgrade-overlay"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="space-overlay-card upgrade-card">
          <span className="game-kicker">{copy.upgradeKicker}</span>
          <h2 id="space-upgrade-title">{copy.chooseUpgrade}</h2>
          <p id="space-upgrade-description">{copy.chooseUpgradeHint}</p>
          {checkpointError && (
            <div className="space-checkpoint-error" role="alert">
              <p>{copy.checkpointSaveFailed}</p>
              <button
                autoFocus
                className="button primary"
                data-dialog-initial-focus
                onClick={onRetryCheckpoint}
                type="button"
              >
                {copy.retrySave}
              </button>
            </div>
          )}
          <div className="space-upgrade-grid">
            {upgradeChoices.map((power) => {
              const current = upgradeStacks[power] ?? 0;
              const maximum = UPGRADE_BALANCE[power].maxStacks;
              return (
                <button
                  autoFocus={!checkpointError && power === upgradeChoices[0]}
                  data-dialog-initial-focus={!checkpointError && power === upgradeChoices[0] ? true : undefined}
                  disabled={checkpointError}
                  key={power}
                  onClick={() => onSelectUpgrade(power)}
                  type="button"
                >
                  <span aria-hidden="true">✦</span>
                  <strong>{copy.upgrades[power].name}</strong>
                  <small>{copy.upgrades[power].description}</small>
                  <em>{copy.upgradeStack}: {copy.formatNumber(current)} → {copy.formatNumber(Math.min(maximum, current + 1))}/{copy.formatNumber(maximum)}</em>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  if (!result) return null;
  const reasonKey = result.endedReason in copy.endReasons
    ? result.endedReason as keyof typeof copy.endReasons
    : "unknown";
  const resultHeading = reasonKey === "victory"
    ? copy.victoryTitle
    : reasonKey === "defeat"
      ? copy.defeatTitle
      : reasonKey === "duration-limit"
        ? copy.durationLimitTitle
        : copy.runEndedTitle;
  return (
    <div
      aria-describedby="space-result-reason space-result-save-status"
      aria-labelledby="space-result-heading"
      aria-modal="true"
      className="space-game-overlay result-overlay"
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <div className="space-overlay-card result-card">
        <span aria-hidden="true" className="space-result-emblem">{result.victory ? "✦" : "◇"}</span>
        <p className="game-kicker">{copy.resultTitle}</p>
        <h2 id="space-result-heading">{resultHeading}</h2>
        <p className="space-result-reason" id="space-result-reason">
          {copy.endReasons[reasonKey]}
        </p>
        {result.newRecord && <div className="space-record-banner">{copy.newRecord}</div>}
        <strong className="space-result-score">{copy.formatNumber(result.score)}</strong>
        <dl className="space-result-grid">
          <div><dt>{copy.hud.wave}</dt><dd>{copy.formatNumber(result.wave)}</dd></div>
          <div><dt>{copy.stats.enemies}</dt><dd>{copy.formatNumber(result.enemies)}</dd></div>
          <div><dt>{copy.stats.bosses}</dt><dd>{copy.formatNumber(result.bosses)}</dd></div>
          <div><dt>{copy.stats.accuracy}</dt><dd>{copy.formatAccuracy(result.accuracy)}</dd></div>
          <div><dt>{copy.stats.combo}</dt><dd>×{copy.formatNumber(result.longestCombo)}</dd></div>
          <div><dt>{copy.stats.longestRun}</dt><dd>{copy.formatDuration(result.durationSeconds)}</dd></div>
        </dl>
        {result.unlockedAchievements.length > 0 && (
          <section className="space-result-achievements">
            <h3>{copy.achievementUnlocked}</h3>
            <ul>
              {result.unlockedAchievements.map((id) => (
                <li key={id}>{copy.achievements[id].name}</li>
              ))}
            </ul>
          </section>
        )}
        <p
          className={`space-result-saved ${result.saved ? "is-saved" : "is-save-error"}`}
          id="space-result-save-status"
          role={result.saved ? "status" : "alert"}
        >
          {result.saved
            ? copy.runSaved
            : result.saveStatus === "profile-mismatch"
              ? copy.runSaveProfileMismatch
              : result.saveStatus === "storage-error"
                ? copy.runSaveStorageError
                : result.saveStatus === "invalid"
                  ? copy.runSaveInvalid
                  : copy.runSaveFailed}
        </p>
        {result.saved && checkpointError && (
          <p className="space-checkpoint-error" role="alert">
            {copy.checkpointClearFailed}
          </p>
        )}
        <div className="space-result-actions">
          {result.saved ? (
            <>
              <button
                autoFocus={canPlayAgain}
                className="button primary"
                data-dialog-initial-focus={canPlayAgain ? true : undefined}
                disabled={!canPlayAgain}
                onClick={onPlayAgain}
                type="button"
              >
                {copy.playAgain}
              </button>
              <button
                autoFocus={!canPlayAgain}
                className="button secondary"
                data-dialog-initial-focus={!canPlayAgain ? true : undefined}
                onClick={onBackToMenu}
                type="button"
              >
                {copy.backToMenu}
              </button>
            </>
          ) : (
            <>
              <button
                autoFocus
                className="button primary"
                data-dialog-initial-focus
                onClick={onRetrySave}
                type="button"
              >
                {copy.retrySave}
              </button>
              <button className="button secondary" onClick={onManageSave} type="button">
                {copy.resolveSave}
              </button>
              <button className="button secondary" onClick={onExportRecovery} type="button">
                {copy.exportRecovery}
              </button>
              {result.recoveryExported && (
                <button className="button danger" onClick={onDiscardUnsavedResult} type="button">
                  {copy.discardExportedResult}
                </button>
              )}
            </>
          )}
        </div>
        {result.saved && !canPlayAgain && <p className="space-menu-warning">{copy.playAgainUnavailable}</p>}
      </div>
    </div>
  );
}

export type GameToast = {
  id: string;
  icon: string;
  kind:
    | "achievement"
    | "boss"
    | "power-active"
    | "power-collected"
    | "power-cooldown"
    | "power-low-energy"
    | "power-not-needed"
    | "record"
    | "sector"
    | "warning";
  subtitle?: string;
  title: string;
};

export function GameToastStack({ copy, toasts }: { copy: SpaceDefenderCopy; toasts: readonly GameToast[] }) {
  return (
    <div aria-live="polite" aria-relevant="additions" className="space-toast-stack">
      {toasts.map((toast) => (
        <article className={`space-toast is-${toast.kind}`} key={toast.id} role="status">
          <span aria-hidden="true">{toast.icon}</span>
          <div>
            <small>
              {toast.kind === "achievement"
                ? copy.achievementUnlocked
                : toast.kind === "boss"
                  ? copy.bossDefeated
                  : toast.kind === "power-collected"
                    ? copy.powerCollected
                    : toast.kind === "power-active"
                      ? copy.powerActivated
                      : toast.kind === "power-cooldown"
                        ? copy.powerCooldown
                      : toast.kind === "power-low-energy"
                        ? copy.powerLowEnergy
                        : toast.kind === "power-not-needed"
                          ? copy.powerNotNeeded
                          : toast.kind === "sector"
                            ? copy.sectorCleared
                            : toast.kind === "record"
                              ? copy.newRecord
                              : copy.hud.danger}
            </small>
            <strong>{toast.title}</strong>
            {toast.subtitle && <p>{toast.subtitle}</p>}
          </div>
        </article>
      ))}
    </div>
  );
}
