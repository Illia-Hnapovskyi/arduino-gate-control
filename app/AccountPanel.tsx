"use client";

import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  GAME_STATS_API_PATH,
  generateRandomNickname,
  validateNickname,
  type GameStatsLanguage,
  type ProfileResponse,
} from "../shared/gameStats";
import { useAuthSession } from "./auth/useAuthSession";
import ConsentPanel from "./ConsentPanel";
import type { PlayerStatsCopy } from "./PlayerStatsPanel";
import { GameStatsClientError } from "./useGameStats";
import type {
  GameStatsProfileSummary,
  UseGameStatsResult,
} from "./useGameStats";

// ── Game-activity signal ──────────────────────────────────────────────────
// page.tsx publishes the same "game data at risk" flag it already uses to
// lock the site tabs; profile switching is blocked while it is raised.

let gameActivityBlocked = false;
const gameActivityListeners = new Set<() => void>();

export function setGameActivityBlocked(blocked: boolean) {
  if (gameActivityBlocked === blocked) return;
  gameActivityBlocked = blocked;
  for (const listener of gameActivityListeners) listener();
}

function subscribeToGameActivity(listener: () => void) {
  gameActivityListeners.add(listener);
  return () => {
    gameActivityListeners.delete(listener);
  };
}

function readGameActivityBlocked() {
  return gameActivityBlocked;
}

function serverGameActivitySnapshot() {
  return false;
}

// GamePanel mirrors its run status here so useGameStats({ isRunActive }) can
// refuse profile switches mid-run without capturing render-scoped refs.

let gameRunActive = false;

export function setGameRunActive(active: boolean) {
  gameRunActive = active;
}

export function isGameRunActive() {
  return gameRunActive;
}

// ── Shared modal dialog (focus handling mirrors GameOverlays) ────────────

export function AccountDialog({
  children,
  describedBy,
  labelledBy,
}: {
  children: ReactNode;
  describedBy?: string;
  labelledBy: string;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (document.activeElement instanceof HTMLElement) {
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
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", trapFocus);
    return () => {
      dialog.removeEventListener("keydown", trapFocus);
      if (previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus();
      }
    };
  }, []);

  return (
    <div className="account-dialog-backdrop">
      <div
        aria-describedby={describedBy}
        aria-labelledby={labelledBy}
        aria-modal="true"
        className="account-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}

// ── Account panel ─────────────────────────────────────────────────────────

export type AccountPanelProps = {
  copy: PlayerStatsCopy;
  disabled?: boolean;
  language: GameStatsLanguage;
  stats: UseGameStatsResult;
};

type AccountFormMode = "signin" | "signup" | "forgot";

type AccountBusyAction =
  | "signin"
  | "signup"
  | "forgot"
  | "google"
  | "apple"
  | "link"
  | "unlink"
  | "signout"
  | "signout-all"
  | "session";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function extractErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isProfileResponseLike(body: unknown): body is ProfileResponse {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const profile = (body as { profile?: unknown }).profile;
  return Boolean(profile) && typeof profile === "object";
}

// The vault entry of the active profile is resolved by its local profile id
// only. Nicknames are not unique across the vault, so matching on them
// mislabelled a local-only profile as "Active" when it shared a nickname with
// an account profile.
function findActiveSummary(
  stats: UseGameStatsResult,
): GameStatsProfileSummary | null {
  const activeId = stats.activeProfileId;
  if (!activeId) return null;
  return stats.profiles.find((entry) => entry.profileId === activeId) ?? null;
}

// Link/unlink failures carry the server (or hook) error code; a revoked or
// absent session and the two 1:1 conflicts each need their own copy instead of
// the generic auth error.
function accountActionErrorText(error: unknown, copy: PlayerStatsCopy) {
  const code = error instanceof GameStatsClientError ? error.code : null;
  switch (code) {
    case "AUTH_SESSION_REVOKED":
    case "AUTH_TOKEN_EXPIRED":
    case "AUTH_TOKEN_MISSING":
    // The hook raises this local code when no access token is available.
    case "auth_session_missing":
      return copy.accountSessionExpired;
    case "ACCOUNT_PROFILE_CONFLICT":
      return copy.accountLinkConflictAccount;
    case "PROFILE_ACCOUNT_CONFLICT":
      return copy.accountLinkConflictProfile;
    default:
      return copy.accountAuthError;
  }
}

export function AccountPanel({
  copy,
  disabled = false,
  language,
  stats,
}: AccountPanelProps) {
  const auth = useAuthSession();
  const emailId = useId();
  const passwordId = useId();
  const nicknameId = useId();
  const conflictTitleId = useId();
  const conflictBodyId = useId();
  const [formMode, setFormMode] = useState<AccountFormMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [busyAction, setBusyAction] = useState<AccountBusyAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const sessionFlowUserRef = useRef<string | null>(null);
  const switchBlocked = useSyncExternalStore(
    subscribeToGameActivity,
    readGameActivityBlocked,
    serverGameActivitySnapshot,
  );

  const actionsDisabled = disabled || busyAction !== null;
  const activeSummary = findActiveSummary(stats);
  const activeProfileId = activeSummary?.profileId ?? null;
  const activeLinked = stats.profile?.accountLinked ?? false;
  const activeHasAccessCode = Boolean(stats.profile?.accessCode);

  const clearMessages = useCallback(() => {
    setNotice(null);
    setErrorText(null);
  }, []);

  const postAccountStats = useCallback(
    async (payload: Record<string, unknown>) => {
      const token = await auth.getAccessToken();
      if (!token) return { status: 0, code: null as string | null, body: null };
      const response = await fetch(GAME_STATS_API_PATH, {
        body: JSON.stringify(payload),
        cache: "no-store",
        credentials: "omit",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, code: extractErrorCode(body), body };
    },
    [auth],
  );

  const runSessionFlow = useCallback(async () => {
    setBusyAction("session");
    try {
      const session = await postAccountStats({ action: "session" });
      if (session.status === 200 && isProfileResponseLike(session.body)) {
        stats.adoptSessionProfile(session.body);
        return;
      }
      if (session.status === 404 && session.code === "AUTH_NOT_LINKED") {
        if (stats.profile) {
          // A local profile exists: nothing is transferred automatically —
          // the player confirms with the explicit link button below.
          return;
        }
        const validatedNickname = validateNickname(auth.sessionNickname);
        const created = await postAccountStats({
          action: "create",
          language,
          nickname: validatedNickname.ok
            ? validatedNickname.value
            : generateRandomNickname(language),
        });
        if (created.status === 200 && isProfileResponseLike(created.body)) {
          stats.adoptSessionProfile(created.body);
          return;
        }
        if (created.code === "ACCOUNT_PROFILE_CONFLICT") {
          const retried = await postAccountStats({ action: "session" });
          if (retried.status === 200 && isProfileResponseLike(retried.body)) {
            stats.adoptSessionProfile(retried.body);
            return;
          }
        }
        if (created.code === "NICKNAME_TAKEN") {
          // The sign-up nickname is already used by another profile. Retry once
          // with a generated one so the account is not left with no profile and
          // no way forward.
          const withRandomNickname = await postAccountStats({
            action: "create",
            language,
            nickname: generateRandomNickname(language),
          });
          if (
            withRandomNickname.status === 200 &&
            isProfileResponseLike(withRandomNickname.body)
          ) {
            stats.adoptSessionProfile(withRandomNickname.body);
            return;
          }
          setErrorText(copy.nicknameTakenError);
          return;
        }
        setErrorText(copy.accountAuthError);
        return;
      }
      if (session.status === 401) {
        setErrorText(copy.accountSessionExpired);
      }
    } catch (flowError) {
      if (flowError instanceof GameStatsClientError) {
        // The response arrived but was unusable (invalid_response) — that is a
        // real service error, not an offline tab. Report it and clear the guard
        // so the flow can run again instead of staying silently stuck.
        setErrorText(copy.accountAuthError);
        sessionFlowUserRef.current = null;
      }
      // Otherwise offline or interrupted — the queue keeps working locally and
      // the flow reruns after the next sign-in event.
    } finally {
      setBusyAction(null);
    }
  }, [
    auth.sessionNickname,
    copy.accountAuthError,
    copy.accountSessionExpired,
    copy.nicknameTakenError,
    language,
    postAccountStats,
    stats,
  ]);

  // The flow is invoked through a ref so the effect below depends on the auth
  // identity alone. runSessionFlow is rebuilt on every render, and clearing the
  // guard after a failure would otherwise retry it on every render.
  const sessionFlowRef = useRef(runSessionFlow);
  useEffect(() => {
    sessionFlowRef.current = runSessionFlow;
  }, [runSessionFlow]);

  useEffect(() => {
    if (!auth.hasSession || !auth.sessionUserId) {
      sessionFlowUserRef.current = null;
      return;
    }
    if (sessionFlowUserRef.current === auth.sessionUserId) return;
    sessionFlowUserRef.current = auth.sessionUserId;
    void sessionFlowRef.current();
  }, [auth.hasSession, auth.sessionUserId]);

  if (!auth.authAvailable) return null;

  const handleConsentChoice = (choice: "local" | "account") => {
    auth.chooseConsent(choice);
    setConsentOpen(false);
    clearMessages();
  };

  const handleSignIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (actionsDisabled) return;
    clearMessages();
    if (!EMAIL_PATTERN.test(email.trim())) {
      setErrorText(copy.accountEmailInvalid);
      return;
    }
    if (!password) {
      setErrorText(copy.accountAuthError);
      return;
    }
    setBusyAction("signin");
    const result = await auth.signInEmail(email.trim(), password);
    setBusyAction(null);
    if (!result.ok) {
      setErrorText(copy.accountAuthError);
      return;
    }
    setPassword("");
  };

  const handleSignUp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (actionsDisabled) return;
    clearMessages();
    if (!EMAIL_PATTERN.test(email.trim())) {
      setErrorText(copy.accountEmailInvalid);
      return;
    }
    if (password.length < 8) {
      setErrorText(copy.accountPasswordTooShort);
      return;
    }
    if (!nickname.trim()) {
      setErrorText(copy.nicknameRequiredError);
      return;
    }
    const validatedNickname = validateNickname(nickname);
    if (!validatedNickname.ok) {
      setErrorText(copy.nicknameInvalidError);
      return;
    }
    setBusyAction("signup");
    const result = await auth.signUpEmail(
      email.trim(),
      password,
      validatedNickname.value,
    );
    setBusyAction(null);
    if (!result.ok) {
      setErrorText(copy.accountAuthError);
      return;
    }
    setPassword("");
    if (result.needsConfirmation) setNotice(copy.accountConfirmSent);
  };

  const handleForgot = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (actionsDisabled) return;
    clearMessages();
    if (!EMAIL_PATTERN.test(email.trim())) {
      setErrorText(copy.accountEmailInvalid);
      return;
    }
    setBusyAction("forgot");
    const result = await auth.resetPassword(email.trim());
    setBusyAction(null);
    if (!result.ok) {
      setErrorText(copy.accountAuthError);
      return;
    }
    setNotice(copy.accountResetSent);
    setFormMode("signin");
  };

  const handleProvider = async (provider: "google" | "apple") => {
    if (actionsDisabled) return;
    clearMessages();
    setBusyAction(provider);
    const result =
      provider === "google"
        ? await auth.signInGoogle()
        : await auth.signInApple();
    setBusyAction(null);
    if (!result.ok) setErrorText(copy.accountAuthError);
  };

  const handleLink = async () => {
    if (actionsDisabled) return;
    clearMessages();
    setBusyAction("link");
    try {
      const outcome = await stats.linkActiveProfile();
      if (outcome === "linked") {
        setNotice(copy.accountLinkDone);
      } else if (outcome === "already-linked") {
        setNotice(copy.accountAlreadyLinked);
      } else if (outcome === "account-conflict") {
        setErrorText(copy.accountLinkConflictAccount);
      } else if (outcome === "profile-conflict") {
        setErrorText(copy.accountLinkConflictProfile);
      }
    } catch (error) {
      setErrorText(accountActionErrorText(error, copy));
    } finally {
      setBusyAction(null);
    }
  };

  const handleUnlink = async () => {
    if (actionsDisabled) return;
    clearMessages();
    setBusyAction("unlink");
    try {
      await stats.unlinkActiveProfile();
      setNotice(copy.accountNotLinked);
    } catch (error) {
      setErrorText(accountActionErrorText(error, copy));
    } finally {
      setBusyAction(null);
    }
  };

  const handleSignOut = async (scope: "local" | "global") => {
    if (actionsDisabled) return;
    clearMessages();
    setBusyAction(scope === "local" ? "signout" : "signout-all");
    const result =
      scope === "local"
        ? await auth.signOutLocal()
        : await auth.signOutGlobal();
    setBusyAction(null);
    if (!result.ok) setErrorText(copy.accountAuthError);
  };

  const handleSwitchProfile = (profileId: string) => {
    if (actionsDisabled || switchBlocked) return;
    clearMessages();
    stats.switchProfile(profileId);
  };

  const conflict = stats.accountConflict;

  return (
    <section aria-label={copy.accountTitle} className="account-section">
      <div className="account-heading">
        <h3>{copy.accountTitle}</h3>
        <button
          aria-expanded={consentOpen}
          className="account-text-button"
          onClick={() => setConsentOpen((current) => !current)}
          type="button"
        >
          {copy.consentSettings}
        </button>
      </div>

      {consentOpen && (
        <ConsentPanel
          copy={copy}
          currentChoice={auth.consent}
          mode="inline"
          onChoose={handleConsentChoice}
        />
      )}

      {auth.consent !== "account" ? (
        <div className="account-consent-prompt">
          <p>{copy.consentChangeLater}</p>
          <button
            className="button secondary"
            disabled={actionsDisabled}
            onClick={() => handleConsentChoice("account")}
            type="button"
          >
            {copy.consentSignIn}
          </button>
        </div>
      ) : !auth.hasSession ? (
        <div className="account-auth">
          <p className="account-subtitle">{copy.accountSubtitle}</p>
          <form
            className="account-form"
            onSubmit={(event) =>
              formMode === "signup"
                ? void handleSignUp(event)
                : formMode === "forgot"
                  ? void handleForgot(event)
                  : void handleSignIn(event)
            }
          >
            <label htmlFor={emailId}>{copy.accountEmailLabel}</label>
            <input
              autoComplete="email"
              disabled={actionsDisabled}
              id={emailId}
              inputMode="email"
              onChange={(event) => {
                setEmail(event.target.value);
                setErrorText(null);
              }}
              type="email"
              value={email}
            />
            {formMode !== "forgot" && (
              <>
                <label htmlFor={passwordId}>{copy.accountPasswordLabel}</label>
                <input
                  autoComplete={
                    formMode === "signup" ? "new-password" : "current-password"
                  }
                  disabled={actionsDisabled}
                  id={passwordId}
                  minLength={formMode === "signup" ? 8 : undefined}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setErrorText(null);
                  }}
                  type="password"
                  value={password}
                />
              </>
            )}
            {formMode === "signup" && (
              <>
                <label htmlFor={nicknameId}>{copy.accountNicknameLabel}</label>
                <input
                  autoComplete="nickname"
                  disabled={actionsDisabled}
                  id={nicknameId}
                  maxLength={20}
                  onChange={(event) => {
                    setNickname(event.target.value);
                    setErrorText(null);
                  }}
                  value={nickname}
                />
              </>
            )}
            <div className="account-form-actions">
              <button
                className="button primary"
                disabled={actionsDisabled}
                type="submit"
              >
                {formMode === "signup"
                  ? copy.accountSignUp
                  : formMode === "forgot"
                    ? copy.accountForgotPassword
                    : copy.accountSignIn}
              </button>
              {formMode !== "signin" && (
                <button
                  className="account-text-button"
                  disabled={actionsDisabled}
                  onClick={() => {
                    setFormMode("signin");
                    clearMessages();
                  }}
                  type="button"
                >
                  {copy.accountSignIn}
                </button>
              )}
              {formMode === "signin" && (
                <>
                  <button
                    className="account-text-button"
                    disabled={actionsDisabled}
                    onClick={() => {
                      setFormMode("signup");
                      clearMessages();
                    }}
                    type="button"
                  >
                    {copy.accountSignUp}
                  </button>
                  <button
                    className="account-text-button"
                    disabled={actionsDisabled}
                    onClick={() => {
                      setFormMode("forgot");
                      clearMessages();
                    }}
                    type="button"
                  >
                    {copy.accountForgotPassword}
                  </button>
                </>
              )}
            </div>
          </form>
          <div className="account-divider">
            <span>{copy.accountOrDivider}</span>
          </div>
          <div className="account-oauth">
            <button
              className="button secondary"
              disabled={actionsDisabled}
              onClick={() => void handleProvider("google")}
              type="button"
            >
              {copy.accountGoogle}
            </button>
            {auth.appleEnabled && (
              <button
                className="button secondary"
                disabled={actionsDisabled}
                onClick={() => void handleProvider("apple")}
                type="button"
              >
                {copy.accountApple}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="account-signed-in">
          <p className="account-email">
            <span className="sr-only">{copy.accountEmailLabel}: </span>
            {auth.sessionEmail}
          </p>
          {stats.profile && (
            <p aria-live="polite" className="account-link-status" role="status">
              {activeLinked ? copy.accountLinked : copy.accountNotLinked}
            </p>
          )}
          <div className="account-form-actions">
            {stats.profile && !activeLinked && activeHasAccessCode && (
              <button
                className="button secondary"
                disabled={actionsDisabled}
                onClick={() => void handleLink()}
                type="button"
              >
                {copy.accountLinkProfile}
              </button>
            )}
            {stats.profile && activeLinked && activeHasAccessCode && (
              <button
                className="account-text-button"
                disabled={actionsDisabled}
                onClick={() => void handleUnlink()}
                type="button"
              >
                {copy.accountUnlinkProfile}
              </button>
            )}
            <button
              className="account-text-button"
              disabled={actionsDisabled}
              onClick={() => void handleSignOut("local")}
              type="button"
            >
              {copy.accountSignOut}
            </button>
            <button
              className="account-text-button"
              disabled={actionsDisabled}
              onClick={() => void handleSignOut("global")}
              type="button"
            >
              {copy.accountSignOutAll}
            </button>
          </div>
        </div>
      )}

      {stats.profiles.length > 1 && (
        <div className="account-profiles">
          <h4>{copy.profilesTitle}</h4>
          <ul>
            {stats.profiles.map((entry) => {
              const isActive = activeProfileId === entry.profileId;
              return (
                <li className="account-profile-row" key={entry.profileId}>
                  <div>
                    <strong>{entry.nickname}</strong>
                    <small>
                      {entry.accountLinked
                        ? copy.profilesAccount
                        : copy.profilesLocalOnly}
                    </small>
                  </div>
                  {isActive ? (
                    <span className="account-profile-active">
                      {copy.profilesActive}
                    </span>
                  ) : (
                    <button
                      className="button secondary"
                      disabled={actionsDisabled || switchBlocked}
                      onClick={() => handleSwitchProfile(entry.profileId)}
                      type="button"
                    >
                      {copy.profilesSwitch}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {notice && (
        <p aria-live="polite" className="profile-result-status" role="status">
          {notice}
        </p>
      )}
      {errorText && (
        <p className="profile-error" role="alert">
          {errorText}
        </p>
      )}

      {conflict && (
        <AccountDialog
          describedBy={conflictBodyId}
          labelledBy={conflictTitleId}
        >
          <h3 id={conflictTitleId}>{copy.conflictTitle}</h3>
          <p id={conflictBodyId}>{copy.conflictBody}</p>
          {conflict.accountProfile.nickname && (
            <p className="account-conflict-nickname">
              <strong>{conflict.accountProfile.nickname}</strong>
            </p>
          )}
          <p className="account-dialog-note">{copy.conflictVaultNote}</p>
          <div className="account-dialog-actions">
            <button
              className="button primary"
              data-dialog-initial-focus
              onClick={() => stats.resolveConflict("keep-local")}
              type="button"
            >
              {copy.conflictKeepLocal}
            </button>
            <button
              className="button secondary"
              onClick={() => stats.resolveConflict("use-account")}
              type="button"
            >
              {copy.conflictUseAccount}
            </button>
          </div>
        </AccountDialog>
      )}
    </section>
  );
}

export default AccountPanel;
