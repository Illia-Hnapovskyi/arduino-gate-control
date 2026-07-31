"use client";

import {
  type FormEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  formatAccessCode,
  type GameStatsLanguage,
  validateAccessCode,
  validateNickname,
} from "../shared/gameStats";
import {
  GameStatsClientError,
  type GameStatsError,
  type GameStatsSyncStatus,
  type UseGameStatsResult,
} from "./useGameStats";

export type PlayerStatsCopy = {
  profileEyebrow: string;
  profileTitle: string;
  profileSetupExplanation: string;
  nicknameLabel: string;
  nicknamePlaceholder: string;
  saveNickname: string;
  useRandomNickname: string;
  nicknameRequiredError: string;
  nicknameInvalidError: string;
  nicknameTakenError: string;
  nicknameSaveError: string;
  randomNicknameError: string;
  existingProfilePrompt: string;
  profileCodePlaceholder: string;
  connectProfile: string;
  profileCodeInvalidError: string;
  profileNotFoundError: string;
  profileConnectError: string;
  publicNicknameNotice: string;
  syncSynced: string;
  syncSyncing: string;
  syncOffline: string;
  syncLocalOnly: string;
  syncError: string;
  syncRetry: string;
  changeNickname: string;
  editNickname: string;
  saveNicknameChanges: string;
  cancelNicknameEdit: string;
  profileCodeLabel: string;
  showProfileCode: string;
  hideProfileCode: string;
  copyProfileCode: string;
  profileCodeCopied: string;
  profileCodeExplanation: string;
  forgetProfile: string;
  forgetProfileConfirm: string;
  statBestScore: string;
  statGamesPlayed: string;
  statTotalScore: string;
  statHighestLevel: string;
  statPlayTime: string;
  leaderboardTitle: string;
  leaderboardEmpty: string;
  leaderboardLoading: string;
  leaderboardRowGames: (games: number) => string;
  resultSaved: string;
  resultPending: string;
  formatPlayTime: (seconds: number) => string;
};

export type PlayerStatsPanelProps = {
  copy: PlayerStatsCopy;
  disabled?: boolean;
  language: GameStatsLanguage;
  stats: UseGameStatsResult;
};

export type LeaderboardPanelProps = Pick<
  PlayerStatsPanelProps,
  "copy" | "language" | "stats"
>;

type FormError = string | null;

function localizedError(error: GameStatsError, copy: PlayerStatsCopy) {
  const code = error.code.toUpperCase();
  if (code === "NICKNAME_TAKEN") return copy.nicknameTakenError;
  if (code === "RANDOM_NICKNAME_UNAVAILABLE") {
    return copy.randomNicknameError;
  }
  if (code === "PROFILE_NOT_FOUND") return copy.profileNotFoundError;
  if (code === "INVALID_ACCESS_CODE") return copy.profileCodeInvalidError;
  if (error.operation === "connect") return copy.profileConnectError;
  if (error.operation === "create" || error.operation === "rename") {
    return copy.nicknameSaveError;
  }
  return copy.syncError;
}

function actionError(error: unknown, fallback: string, copy: PlayerStatsCopy) {
  if (error instanceof GameStatsClientError) {
    return localizedError(
      {
        code: error.code,
        message: error.message,
        operation: error.operation,
      },
      copy,
    );
  }
  return fallback;
}

function syncLabel(status: GameStatsSyncStatus, copy: PlayerStatsCopy) {
  switch (status) {
    case "loading":
    case "syncing":
      return copy.syncSyncing;
    case "offline":
      return copy.syncOffline;
    case "local-only":
      return copy.syncLocalOnly;
    case "error":
      return copy.syncError;
    default:
      return copy.syncSynced;
  }
}

function localeFor(language: GameStatsLanguage) {
  if (language === "uk") return "uk-UA";
  if (language === "de") return "de-DE";
  return "en-GB";
}

export function LeaderboardPanel({
  copy,
  language,
  stats,
}: LeaderboardPanelProps) {
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(localeFor(language)),
    [language],
  );
  const profile = stats.profile;

  return (
    <article className="leaderboard-card">
      <div className="leaderboard-heading">
        <span aria-hidden="true">★</span>
        <h2>{copy.leaderboardTitle}</h2>
      </div>

      {stats.leaderboard.length === 0 &&
      (stats.status === "loading" || stats.status === "syncing") ? (
        <p aria-live="polite" className="leaderboard-state" role="status">
          {copy.leaderboardLoading}
        </p>
      ) : stats.leaderboard.length === 0 ? (
        <p className="leaderboard-state">{copy.leaderboardEmpty}</p>
      ) : (
        <ol className="leaderboard-list">
          {stats.leaderboard.map((entry) => {
            const isCurrentPlayer =
              stats.status === "synced" && entry.nickname === profile?.nickname;
            return (
              <li
                aria-current={isCurrentPlayer ? "true" : undefined}
                className={isCurrentPlayer ? "is-current-player" : undefined}
                key={`${entry.rank}-${entry.nickname}`}
              >
                <span className="leaderboard-rank">{entry.rank}</span>
                <div className="leaderboard-player">
                  <strong>{entry.nickname}</strong>
                  <small>{copy.leaderboardRowGames(entry.gamesPlayed)}</small>
                </div>
                <div className="leaderboard-score">
                  <strong>{numberFormatter.format(entry.highScore)}</strong>
                  <small>
                    {copy.statHighestLevel} {entry.highestLevel}
                  </small>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </article>
  );
}

export function PlayerStatsPanel({
  copy,
  disabled = false,
  language,
  stats,
}: PlayerStatsPanelProps) {
  const nicknameId = useId();
  const connectCodeId = useId();
  const renameId = useId();
  const profileCodeId = useId();
  const [nickname, setNickname] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [formError, setFormError] = useState<FormError>(null);
  const [busyAction, setBusyAction] = useState<
    "create" | "random" | "connect" | "rename" | null
  >(null);
  const [editingNickname, setEditingNickname] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(localeFor(language)),
    [language],
  );
  const profile = stats.profile;
  const actionsDisabled = disabled || busyAction !== null;
  const statusText = syncLabel(stats.status, copy);
  const serviceError = stats.error
    ? localizedError(stats.error, copy)
    : null;

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (actionsDisabled) return;
    const validated = validateNickname(nickname);
    if (!nickname.trim()) {
      setFormError(copy.nicknameRequiredError);
      return;
    }
    if (!validated.ok) {
      setFormError(copy.nicknameInvalidError);
      return;
    }

    setBusyAction("create");
    setFormError(null);
    try {
      await stats.createProfile(validated.value);
      setNickname("");
    } catch (error) {
      setFormError(actionError(error, copy.nicknameSaveError, copy));
    } finally {
      setBusyAction(null);
    }
  };

  const handleRandomProfile = async () => {
    if (actionsDisabled) return;
    setBusyAction("random");
    setFormError(null);
    try {
      await stats.createProfile();
      setNickname("");
    } catch (error) {
      setFormError(actionError(error, copy.randomNicknameError, copy));
    } finally {
      setBusyAction(null);
    }
  };

  const handleConnect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (actionsDisabled) return;
    const validated = validateAccessCode(accessCode);
    if (!validated.ok) {
      setFormError(copy.profileCodeInvalidError);
      return;
    }

    setBusyAction("connect");
    setFormError(null);
    try {
      await stats.connectProfile(validated.value);
      setAccessCode("");
    } catch (error) {
      setFormError(actionError(error, copy.profileConnectError, copy));
    } finally {
      setBusyAction(null);
    }
  };

  const startNicknameEdit = () => {
    if (!profile || actionsDisabled) return;
    setRenameValue(profile.nickname);
    setFormError(null);
    setEditingNickname(true);
  };

  const cancelNicknameEdit = () => {
    setEditingNickname(false);
    setRenameValue("");
    setFormError(null);
  };

  const handleRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (actionsDisabled) return;
    const validated = validateNickname(renameValue);
    if (!validated.ok) {
      setFormError(
        renameValue.trim()
          ? copy.nicknameInvalidError
          : copy.nicknameRequiredError,
      );
      return;
    }

    setBusyAction("rename");
    setFormError(null);
    try {
      await stats.renameProfile(validated.value);
      setEditingNickname(false);
      setRenameValue("");
    } catch (error) {
      setFormError(actionError(error, copy.nicknameSaveError, copy));
    } finally {
      setBusyAction(null);
    }
  };

  const copyAccessCode = async () => {
    if (!profile) return;
    try {
      await navigator.clipboard.writeText(formatAccessCode(profile.accessCode));
      setCodeCopied(true);
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(
        () => setCodeCopied(false),
        2200,
      );
    } catch {
      setShowCode(true);
    }
  };

  const forgetProfile = () => {
    if (actionsDisabled || !window.confirm(copy.forgetProfileConfirm)) return;
    setEditingNickname(false);
    setShowCode(false);
    setFormError(null);
    stats.forgetProfile();
  };

  const retry = () => {
    setFormError(null);
    void stats.retrySync();
  };

  return (
    <section
      aria-labelledby={`${profileCodeId}-section-title`}
      className="player-stats-section"
    >
      <article className="player-profile-card">
        <div className="profile-heading">
          <div>
            <p className="eyebrow">{copy.profileEyebrow}</p>
            <h2 id={`${profileCodeId}-section-title`}>{copy.profileTitle}</h2>
          </div>
          {profile && (
            <span
              aria-live="polite"
              className={`profile-sync-status is-${stats.status}`}
              role="status"
            >
              <i aria-hidden="true" />
              {statusText}
            </span>
          )}
        </div>

        {!profile ? (
          <div className="profile-setup">
            <p className="profile-setup-copy">
              {copy.profileSetupExplanation}
            </p>

            <form className="profile-create-form" onSubmit={handleCreate}>
              <label htmlFor={nicknameId}>{copy.nicknameLabel}</label>
              <div className="profile-input-action">
                <input
                  autoComplete="nickname"
                  disabled={actionsDisabled}
                  id={nicknameId}
                  maxLength={20}
                  onChange={(event) => {
                    setNickname(event.target.value);
                    setFormError(null);
                  }}
                  placeholder={copy.nicknamePlaceholder}
                  value={nickname}
                />
                <button
                  className="button primary"
                  disabled={actionsDisabled}
                  type="submit"
                >
                  {copy.saveNickname}
                </button>
              </div>
              <button
                className="profile-random-button"
                disabled={actionsDisabled}
                onClick={() => void handleRandomProfile()}
                type="button"
              >
                <span aria-hidden="true">✦</span>
                {copy.useRandomNickname}
              </button>
            </form>

            <div className="profile-connect-divider">
              <span>{copy.existingProfilePrompt}</span>
            </div>

            <form className="profile-connect-form" onSubmit={handleConnect}>
              <label className="sr-only" htmlFor={connectCodeId}>
                {copy.profileCodeLabel}
              </label>
              <input
                autoCapitalize="characters"
                autoComplete="off"
                disabled={actionsDisabled}
                id={connectCodeId}
                inputMode="text"
                onChange={(event) => {
                  setAccessCode(event.target.value);
                  setFormError(null);
                }}
                placeholder={copy.profileCodePlaceholder}
                spellCheck={false}
                value={accessCode}
              />
              <button
                className="button secondary"
                disabled={actionsDisabled}
                type="submit"
              >
                {copy.connectProfile}
              </button>
            </form>

            <p className="profile-privacy-note">
              <span aria-hidden="true">i</span>
              {copy.publicNicknameNotice}
            </p>
          </div>
        ) : (
          <div className="profile-details">
            <div className="profile-identity">
              {editingNickname ? (
                <form className="profile-rename-form" onSubmit={handleRename}>
                  <label htmlFor={renameId}>{copy.changeNickname}</label>
                  <div className="profile-input-action">
                    <input
                      autoComplete="nickname"
                      autoFocus
                      disabled={actionsDisabled}
                      id={renameId}
                      maxLength={20}
                      onChange={(event) => {
                        setRenameValue(event.target.value);
                        setFormError(null);
                      }}
                      value={renameValue}
                    />
                    <button disabled={actionsDisabled} type="submit">
                      {copy.saveNicknameChanges}
                    </button>
                    <button
                      disabled={busyAction !== null}
                      onClick={cancelNicknameEdit}
                      type="button"
                    >
                      {copy.cancelNicknameEdit}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="profile-name-row">
                  <div>
                    <small>{copy.nicknameLabel}</small>
                    <strong>{profile.nickname}</strong>
                  </div>
                  <button
                    disabled={actionsDisabled}
                    onClick={startNicknameEdit}
                    type="button"
                  >
                    {copy.editNickname}
                  </button>
                </div>
              )}
            </div>

            <dl className="stats-grid">
              <div className="stats-primary">
                <dt>{copy.statBestScore}</dt>
                <dd>{numberFormatter.format(profile.highScore)}</dd>
              </div>
              <div>
                <dt>{copy.statGamesPlayed}</dt>
                <dd>{numberFormatter.format(profile.gamesPlayed)}</dd>
              </div>
              <div>
                <dt>{copy.statTotalScore}</dt>
                <dd>{numberFormatter.format(profile.totalScore)}</dd>
              </div>
              <div>
                <dt>{copy.statHighestLevel}</dt>
                <dd>{numberFormatter.format(profile.highestLevel)}</dd>
              </div>
              <div>
                <dt>{copy.statPlayTime}</dt>
                <dd>
                  {copy.formatPlayTime(profile.totalDurationMs / 1000)}
                </dd>
              </div>
            </dl>

            <div className="profile-code-box">
              <div className="profile-code-heading">
                <label id={`${profileCodeId}-label`}>
                  {copy.profileCodeLabel}
                </label>
                <button
                  aria-controls={profileCodeId}
                  aria-expanded={showCode}
                  onClick={() => setShowCode((current) => !current)}
                  type="button"
                >
                  {showCode ? copy.hideProfileCode : copy.showProfileCode}
                </button>
              </div>
              <div className="profile-code-value">
                <code
                  aria-labelledby={`${profileCodeId}-label`}
                  id={profileCodeId}
                >
                  {showCode
                    ? formatAccessCode(profile.accessCode)
                    : "•••••-•••••-•••••-•••••"}
                </code>
                <button onClick={() => void copyAccessCode()} type="button">
                  {codeCopied ? copy.profileCodeCopied : copy.copyProfileCode}
                </button>
              </div>
              <p>{copy.profileCodeExplanation}</p>
            </div>

            {profile.gamesPlayed > 0 && (
              <div aria-live="polite" className="profile-result-status">
                {stats.pendingCount > 0
                  ? copy.resultPending
                  : copy.resultSaved}
              </div>
            )}

            <button
              className="profile-forget-button"
              disabled={actionsDisabled}
              onClick={forgetProfile}
              type="button"
            >
              {copy.forgetProfile}
            </button>
          </div>
        )}

        {(formError || serviceError) && (
          <p className="profile-error" role="alert">
            {formError ?? serviceError}
          </p>
        )}
        {(stats.status === "offline" || stats.status === "error") && (
          <button className="profile-retry-button" onClick={retry} type="button">
            {copy.syncRetry}
          </button>
        )}
      </article>

    </section>
  );
}

export default PlayerStatsPanel;
