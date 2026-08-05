"use client";

import {
  type FormEvent,
  useId,
  useMemo,
  useState,
} from "react";
import {
  type GameStatsLanguage,
  validateNickname,
} from "../shared/gameStats";
import {
  GameStatsClientError,
  type GameStatsError,
  type GameStatsSyncStatus,
  type UseGameStatsResult,
} from "./useGameStats";
import AccountPanel from "./AccountPanel";
import { useAuthSession } from "./auth/useAuthSession";
import { authAvailable } from "./auth/supabaseConfig";

export type PlayerStatsCopy = {
  profileEyebrow: string;
  profileTitle: string;
  profileSetupExplanation: string;
  nicknameLabel: string;
  nicknamePlaceholder: string;
  useRandomNickname: string;
  nicknameRequiredError: string;
  nicknameInvalidError: string;
  nicknameTakenError: string;
  nicknameSaveError: string;
  randomNicknameError: string;
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
  accountTitle: string;
  accountSubtitle: string;
  accountEmailLabel: string;
  accountPasswordLabel: string;
  accountNicknameLabel: string;
  accountSignIn: string;
  accountSignUp: string;
  accountSignOut: string;
  accountSignOutAll: string;
  accountForgotPassword: string;
  accountResetSent: string;
  accountConfirmSent: string;
  accountPasswordUpdated: string;
  accountNewPasswordLabel: string;
  accountUpdatePassword: string;
  accountGoogle: string;
  accountApple: string;
  accountOrDivider: string;
  accountRequiredTitle: string;
  accountRequiredBody: string;
  accountCreateProfileTitle: string;
  accountCreateProfileAction: string;
  accountProviderUnavailable: string;
  accountCodeRetiredNotice: string;
  accountOfflineNotice: string;
  accountPasskeyTitle: string;
  accountPasskeyAddAction: string;
  accountPasskeySignInAction: string;
  accountPasskeyUnavailable: string;
  accountPasskeyEmpty: string;
  accountPasskeyRecoveryHint: string;
  accountPasskeyDeleteAction: string;
  accountPasskeyDeleteConfirm: string;
  accountSessionExpired: string;
  accountAuthError: string;
  accountEmailInvalid: string;
  accountPasswordTooShort: string;
  profilesTitle: string;
  profilesSwitch: string;
  profilesActive: string;
  profilesLocalOnly: string;
  profilesAccount: string;
  consentTitle: string;
  consentIntro: string;
  consentItemRequired: string;
  consentItemAuth: string;
  consentItemProviders: string;
  consentItemAnalytics: string;
  consentItemMarketing: string;
  consentContinueLocal: string;
  consentSignIn: string;
  consentSettings: string;
  consentChangeLater: string;
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
  if (code === "CODE_LOGIN_RETIRED") return copy.accountCodeRetiredNotice;
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

// Codes that mean the account session behind a profile is gone or no longer
// owns it. Such a profile can never drain its queue again, so the otherwise
// hidden forget action must stay reachable — as it must for an orphaned legacy
// profile, whose retired code the API refuses outright.
const SESSION_LOST_CODES = new Set([
  "auth_session_missing",
  "AUTH_NOT_LINKED",
  "AUTH_SESSION_REVOKED",
  "AUTH_TOKEN_EXPIRED",
  "AUTH_TOKEN_INVALID",
  "AUTH_TOKEN_MISSING",
]);

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
  const auth = useAuthSession();
  const sectionId = useId();
  const nicknameId = useId();
  const renameId = useId();
  const [nicknameDraft, setNicknameDraft] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [formError, setFormError] = useState<FormError>(null);
  const [busyAction, setBusyAction] = useState<
    "create" | "random" | "rename" | null
  >(null);
  const [editingNickname, setEditingNickname] = useState(false);
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
  // The sign-up nickname arrives in the session metadata, so the create prompt
  // starts from it while still being fully editable.
  const nickname = nicknameDraft ?? auth.sessionNickname ?? "";
  const protectPendingProfile =
    stats.pendingCount > 0 && stats.status !== "synced";
  const stuckQueueProfile =
    profile !== null &&
    (profile.orphaned ||
      (stats.error !== null && SESSION_LOST_CODES.has(stats.error.code)));
  const forceForgetProfile = protectPendingProfile && stuckQueueProfile;
  // An orphaned legacy profile stays readable but can never sync again, so the
  // account prompt is offered beside it: creating the account profile is the
  // only way forward.
  const canCreateProfile =
    auth.hasSession && (profile === null || profile.orphaned);

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
      await stats.createAccountProfile(validated.value);
      setNicknameDraft("");
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
      await stats.createAccountProfile();
      setNicknameDraft("");
    } catch (error) {
      setFormError(actionError(error, copy.randomNicknameError, copy));
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

  const forgetProfile = () => {
    if (actionsDisabled) return;
    if (forceForgetProfile) {
      // Spell out what is lost: this path drops queued runs that no session can
      // ever deliver, so the confirmation names their exact number.
      const confirmation = [
        profile?.orphaned
          ? copy.accountCodeRetiredNotice
          : copy.accountSessionExpired,
        `${copy.resultPending}: ${stats.pendingCount}`,
        copy.forgetProfileConfirm,
      ].join("\n\n");
      if (!window.confirm(confirmation)) return;
      setEditingNickname(false);
      setFormError(null);
      stats.forgetProfile({ force: true });
      return;
    }
    if (!window.confirm(copy.forgetProfileConfirm)) return;
    setEditingNickname(false);
    setFormError(null);
    stats.forgetProfile();
  };

  const retry = () => {
    setFormError(null);
    void stats.retrySync();
  };

  return (
    <section
      aria-labelledby={`${sectionId}-section-title`}
      className="player-stats-section"
    >
      <article className="player-profile-card">
        <div className="profile-heading">
          <div>
            <p className="eyebrow">{copy.profileEyebrow}</p>
            <h2 id={`${sectionId}-section-title`}>{copy.profileTitle}</h2>
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

        {profile && (
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

            {profile.gamesPlayed > 0 && (
              <div aria-live="polite" className="profile-result-status">
                {stats.pendingCount > 0
                  ? copy.resultPending
                  : copy.resultSaved}
              </div>
            )}

            {(!protectPendingProfile || forceForgetProfile) && (
              <button
                className="profile-forget-button"
                disabled={actionsDisabled}
                onClick={forgetProfile}
                type="button"
              >
                {copy.forgetProfile}
              </button>
            )}
          </div>
        )}

        {stats.hasOrphanedProfiles && (
          <p className="profile-retired-notice">
            {copy.accountCodeRetiredNotice}
          </p>
        )}

        {!profile && !auth.hasSession && (
          <div className="profile-setup">
            <h3 className="profile-setup-title">{copy.accountRequiredTitle}</h3>
            <p className="profile-setup-copy">{copy.accountRequiredBody}</p>
          </div>
        )}

        {canCreateProfile && (
          <div className="profile-setup">
            <h3 className="profile-setup-title">
              {copy.accountCreateProfileTitle}
            </h3>
            <p className="profile-setup-copy">{copy.profileSetupExplanation}</p>

            <form className="profile-create-form" onSubmit={handleCreate}>
              <label htmlFor={nicknameId}>{copy.nicknameLabel}</label>
              <div className="profile-input-action">
                <input
                  autoComplete="nickname"
                  disabled={actionsDisabled}
                  id={nicknameId}
                  maxLength={20}
                  onChange={(event) => {
                    setNicknameDraft(event.target.value);
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
                  {copy.accountCreateProfileAction}
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

            <p className="profile-privacy-note">
              <span aria-hidden="true">i</span>
              {copy.publicNicknameNotice}
            </p>
          </div>
        )}

        {authAvailable && (
          <AccountPanel
            copy={copy}
            disabled={disabled}
            language={language}
            stats={stats}
          />
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
