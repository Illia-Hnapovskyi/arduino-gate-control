"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PasskeyListItem, Session } from "@supabase/supabase-js";
import {
  checkOAuthProvider,
  completeAuthRedirect,
  getSupabaseAccessToken,
  getSupabaseClient,
  readConsentChoice,
  REDIRECT_PARAMS,
  saveConsentChoice,
  subscribeToConsentChoice,
  type AuthRedirectKind,
  type ConsentChoice,
} from "./client";
import { APPLE_ENABLED, authAvailable } from "./supabaseConfig";
import { authFailure, type AuthActionResult } from "./errors";

export type { AuthActionResult } from "./errors";

export type AuthSignUpResult = AuthActionResult & {
  needsConfirmation: boolean;
};

export type PasskeySummary = {
  id: string;
  friendlyName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

export type UseAuthSessionResult = {
  appleEnabled: boolean;
  authAvailable: boolean;
  consent: ConsentChoice | null;
  chooseConsent: (choice: ConsentChoice) => void;
  hasSession: boolean;
  sessionEmail: string | null;
  sessionUserId: string | null;
  sessionNickname: string | null;
  getAccessToken: () => Promise<string | null>;
  signUpEmail: (
    email: string,
    password: string,
    nickname: string,
  ) => Promise<AuthSignUpResult>;
  signInEmail: (email: string, password: string) => Promise<AuthActionResult>;
  signInGoogle: () => Promise<AuthActionResult>;
  signInApple: () => Promise<AuthActionResult>;
  resetPassword: (email: string) => Promise<AuthActionResult>;
  updatePassword: (newPassword: string) => Promise<AuthActionResult>;
  signOutLocal: () => Promise<AuthActionResult>;
  signOutGlobal: () => Promise<AuthActionResult>;
  redirectOutcome: AuthRedirectKind | null;
  dismissRedirectOutcome: () => void;
  passkeySupported: boolean;
  passkeyUnavailable: boolean;
  passkeys: PasskeySummary[];
  passkeysLoading: boolean;
  passkeysRefreshFailed: boolean;
  registerPasskey: () => Promise<AuthActionResult>;
  signInWithPasskey: () => Promise<AuthActionResult>;
  listPasskeys: () => Promise<AuthActionResult>;
  deletePasskey: (passkeyId: string) => Promise<AuthActionResult>;
};

// Supabase reports the project-side passkey toggle being off with this code, so
// the client discovers the feature at call time instead of shipping a flag.
const PASSKEY_DISABLED_CODE = "passkey_disabled";

// Structural view of the two error classes a passkey call can return; the
// WebAuthn one is not exported from "@supabase/supabase-js".
type PasskeyCallError = { code?: string };

// Only the disabled toggle is remembered. Everything else — a dismissed browser
// prompt (NotAllowedError/AbortError) included — is a one-off failure that must
// not take the passkey buttons away.
function isPasskeyDisabled(error: PasskeyCallError): boolean {
  return error.code === PASSKEY_DISABLED_CODE;
}

function toPasskeySummary(item: PasskeyListItem): PasskeySummary {
  return {
    id: item.id,
    friendlyName: item.friendly_name ?? null,
    createdAt: item.created_at,
    lastUsedAt: item.last_used_at ?? null,
  };
}

function serverConsentSnapshot(): ConsentChoice | null {
  return null;
}

// Browser WebAuthn support cannot change while the page is open, so this store
// only ever delivers its initial snapshot.
function subscribeToPasskeySupport(): () => void {
  return () => {};
}

function passkeySupportSnapshot(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function"
  );
}

function serverPasskeySupportSnapshot(): boolean {
  return false;
}

// Every provider round trip comes back to the site root, which renders the
// control tab — two clicks away from the profile the player just signed in for.
// `view=game` is how client.ts tells page.tsx where to land instead. Everything
// the current URL was shared with travels along, except the parameters a
// redirect owns: `?lang=de` is the one the whole feature exists for, and
// client.ts refuses to strip it precisely so whoever copies the address bar
// onward gets the same language — a target rebuilt from the bare origin dropped
// it one step earlier and made that refusal say something untrue. The origin
// stays the base, so the target is the same allow-listed root either way, and
// the fragment is left behind: nothing here owns it, and an implicit-grant token
// must never be sent back out. Built with URLSearchParams so an extra parameter
// such as the reset flag is appended rather than overwriting the query.
function authRedirectTarget(extra?: Readonly<Record<string, string>>): string {
  const target = new URL(window.location.origin);
  const current = new URL(window.location.href);
  for (const [key, value] of current.searchParams) {
    if (REDIRECT_PARAMS.includes(key)) continue;
    target.searchParams.set(key, value);
  }
  target.searchParams.set("view", "game");
  for (const [key, value] of Object.entries(extra ?? {})) {
    target.searchParams.set(key, value);
  }
  return target.toString();
}

// ── The redirect notice: one per page load, shared by every hook instance ──
// The outcome of a provider round trip belongs to the page load, not to a
// component. AccountPanel — the only thing that renders the notice — is mounted
// and unmounted with the profile section of the game menu, so a dismissal kept
// in its state came back on the next visit, republished from the memoised
// promise in client.ts. Holding it here gives every instance the same one, lets
// the notice survive until the panel that shows it is finally mounted, and makes
// retiring it final.

let redirectNotice: AuthRedirectKind | null = null;
let redirectNoticeRetired = false;
const redirectNoticeListeners = new Set<() => void>();

function emitRedirectNotice() {
  for (const listener of redirectNoticeListeners) listener();
}

function publishRedirectNotice(kind: AuthRedirectKind) {
  if (redirectNoticeRetired || redirectNotice === kind) return;
  redirectNotice = kind;
  emitRedirectNotice();
}

// Final for the rest of the page load, for two reasons that need the same
// guarantee: a notice the player dismissed may not return on the next mount, and
// a session answers the question the notice asks — "the sign-in did not
// complete" must never sit above a panel showing the player signed in.
function retireRedirectNotice() {
  if (redirectNoticeRetired && redirectNotice === null) return;
  redirectNoticeRetired = true;
  redirectNotice = null;
  emitRedirectNotice();
}

function subscribeToRedirectNotice(listener: () => void) {
  redirectNoticeListeners.add(listener);
  return () => {
    redirectNoticeListeners.delete(listener);
  };
}

function readRedirectNotice(): AuthRedirectKind | null {
  return redirectNotice;
}

function serverRedirectNoticeSnapshot(): AuthRedirectKind | null {
  return null;
}

function metadataNickname(session: Session | null): string | null {
  const metadata = session?.user?.user_metadata as
    | Record<string, unknown>
    | undefined
    | null;
  return typeof metadata?.nickname === "string" ? metadata.nickname : null;
}

export function useAuthSession(): UseAuthSessionResult {
  const consent = useSyncExternalStore(
    subscribeToConsentChoice,
    readConsentChoice,
    serverConsentSnapshot,
  );
  const passkeySupported = useSyncExternalStore(
    subscribeToPasskeySupport,
    passkeySupportSnapshot,
    serverPasskeySupportSnapshot,
  );
  const [session, setSession] = useState<Session | null>(null);
  const sessionIdentityRef = useRef(session?.user?.id ?? null);
  const passkeyRequestRef = useRef(0);
  const [passkeyUnavailable, setPasskeyUnavailable] = useState(false);
  // A fetched list belongs to exactly one account, so it is stored with the
  // owner it was fetched for. Nothing here unmounts on sign-out, so without the
  // owner the next account would inherit the previous one's credentials.
  const [passkeys, setPasskeys] = useState<{
    ownerId: string | null;
    items: PasskeySummary[];
    refreshFailed: boolean;
  }>({ ownerId: null, items: [], refreshFailed: false });
  const [passkeysLoading, setPasskeysLoading] = useState(false);
  const redirectOutcome = useSyncExternalStore(
    subscribeToRedirectNotice,
    readRedirectNotice,
    serverRedirectNoticeSnapshot,
  );

  useEffect(() => {
    if (!authAvailable || consent !== "account") return;
    const client = getSupabaseClient();
    if (!client) return;
    let disposed = false;
    let sessionRevision = 0;
    // Every arriving session goes through here, so a sign-in by any route —
    // this redirect, the e-mail form, a passkey — retires the notice with it.
    const applySession = (next: Session | null) => {
      if (next) retireRedirectNotice();
      setSession(next);
      const nextId = next?.user?.id ?? null;
      if (sessionIdentityRef.current !== nextId) {
        sessionIdentityRef.current = nextId;
        passkeyRequestRef.current += 1;
        setPasskeysLoading(false);
      }
    };
    const settleRedirect = async () => {
      // Finish any provider redirect before reading the session: on the way
      // back from Google the session does not exist yet, and asking first would
      // settle this hook on "signed out" for the rest of the page's life.
      let kind: AuthRedirectKind | null = null;
      try {
        kind = (await completeAuthRedirect()).kind;
      } catch {
        // completeAuthRedirect answers with a kind instead of throwing, so this
        // only guards the history rewrite. Either way the session read below is
        // what decides whether the player is signed in.
      }
      const readRevision = sessionRevision;
      try {
        const { data } = await client.auth.getSession();
        if (!disposed && readRevision === sessionRevision) applySession(data.session);
      } catch {
        if (!disposed && readRevision === sessionRevision) applySession(null);
      }
      // Published only once the session is known: a stale callback opened by a
      // player who is already signed in reports "failed", and that notice must
      // never be painted above the signed-in panel at all.
      if (kind && !disposed) publishRedirectNotice(kind);
    };
    void settleRedirect();
    const { data: subscription } = client.auth.onAuthStateChange(
      (_event, nextSession) => {
        sessionRevision += 1;
        if (!disposed) applySession(nextSession);
      },
    );
    return () => {
      disposed = true;
      sessionIdentityRef.current = null;
      passkeyRequestRef.current += 1;
      subscription.subscription.unsubscribe();
    };
  }, [consent]);

  // The session is only surfaced while account mode is active; flipping the
  // consent back to local hides it without wiping auth storage.
  const activeSession =
    authAvailable && consent === "account" ? session : null;
  const hasSession = activeSession !== null;
  const sessionUserId = activeSession?.user?.id ?? null;

  const chooseConsent = useCallback((choice: ConsentChoice) => {
    saveConsentChoice(choice);
  }, []);

  const getAccessToken = useCallback(() => getSupabaseAccessToken(), []);

  const signUpEmail = useCallback(
    async (
      email: string,
      password: string,
      nickname: string,
    ): Promise<AuthSignUpResult> => {
      const client = getSupabaseClient();
      if (!client) return { ok: false, needsConfirmation: false };
      try {
        // The nickname travels in user metadata so the account-side profile
        // can be created after the e-mail confirmation round-trip.
        const { data, error } = await client.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: authRedirectTarget(),
            data: { nickname },
          },
        });
        if (error) return { ...authFailure(error), needsConfirmation: false };
        return { ok: true, needsConfirmation: data.session === null };
      } catch (error) {
        return { ...authFailure(error), needsConfirmation: false };
      }
    },
    [],
  );

  const signInEmail = useCallback(
    async (email: string, password: string): Promise<AuthActionResult> => {
      const client = getSupabaseClient();
      if (!client) return { ok: false };
      try {
        const { error } = await client.auth.signInWithPassword({
          email,
          password,
        });
        return error ? authFailure(error) : { ok: true };
      } catch (error) {
        return authFailure(error);
      }
    },
    [],
  );

  const signInWithProvider = useCallback(
    async (provider: "google" | "apple"): Promise<AuthActionResult> => {
      if (provider === "apple" && !APPLE_ENABLED) {
        return { ok: false, errorKey: "accountProviderUnavailable" };
      }
      const client = getSupabaseClient();
      if (!client) return { ok: false };
      try {
        const availability = await checkOAuthProvider(provider);
        if (!availability.ok) return availability;
        const { error } = await client.auth.signInWithOAuth({
          provider,
          options: { redirectTo: authRedirectTarget() },
        });
        return error ? authFailure(error, "accountProviderUnavailable") : { ok: true };
      } catch (error) {
        return authFailure(error, "accountProviderUnavailable");
      }
    },
    [],
  );

  const signInGoogle = useCallback(
    () => signInWithProvider("google"),
    [signInWithProvider],
  );
  const signInApple = useCallback(
    () => signInWithProvider("apple"),
    [signInWithProvider],
  );

  const resetPassword = useCallback(
    async (email: string): Promise<AuthActionResult> => {
      const client = getSupabaseClient();
      if (!client) return { ok: false };
      try {
        const { error } = await client.auth.resetPasswordForEmail(email, {
          redirectTo: authRedirectTarget({ reset: "1" }),
        });
        return error ? authFailure(error) : { ok: true };
      } catch (error) {
        return authFailure(error);
      }
    },
    [],
  );

  const updatePassword = useCallback(
    async (newPassword: string): Promise<AuthActionResult> => {
      const client = getSupabaseClient();
      if (!client) return { ok: false };
      try {
        const { error } = await client.auth.updateUser({
          password: newPassword,
        });
        return error ? authFailure(error) : { ok: true };
      } catch (error) {
        return authFailure(error);
      }
    },
    [],
  );

  const signOut = useCallback(
    async (scope: "local" | "global"): Promise<AuthActionResult> => {
      const client = getSupabaseClient();
      if (!client) return { ok: false };
      try {
        const { error } = await client.auth.signOut({ scope });
        return error ? authFailure(error) : { ok: true };
      } catch (error) {
        return authFailure(error);
      }
    },
    [],
  );

  const signOutLocal = useCallback(() => signOut("local"), [signOut]);
  const signOutGlobal = useCallback(() => signOut("global"), [signOut]);

  // Dismissal is for the whole page load: AccountPanel unmounts with the profile
  // section it lives in, and a per-instance flag would let the next visit
  // republish the notice from the still-settled promise in client.ts.
  const dismissRedirectOutcome = useCallback(() => {
    retireRedirectNotice();
  }, []);

  // Listing is a network call the panel triggers when its passkey section
  // becomes visible; it never runs on mount.
  const listPasskeys = useCallback(async (): Promise<AuthActionResult> => {
    const client = getSupabaseClient();
    if (!client || !hasSession) return { ok: false };
    // A mutation begun for a previous account can finish after another account
    // has started its own list read. Its old callback must not advance the
    // request counter and cancel that newer read.
    if (sessionIdentityRef.current !== sessionUserId || readConsentChoice() !== "account") {
      return { ok: true };
    }
    const requestId = ++passkeyRequestRef.current;
    const isCurrent = () => requestId === passkeyRequestRef.current &&
      sessionIdentityRef.current === sessionUserId && readConsentChoice() === "account";
    setPasskeysLoading(true);
    try {
      // The SDK reads its own session for this request. The rendered session
      // may lag a cross-tab change, so check both sides of the list read.
      const before = await client.auth.getSession();
      if (!isCurrent()) return { ok: true };
      if (before.error) throw before.error;
      if (before.data.session?.user.id !== sessionUserId) {
        throw { code: "session_not_found" };
      }
      const { data, error } = await client.auth.passkey.list();
      if (!isCurrent()) return { ok: true };
      const after = await client.auth.getSession();
      if (!isCurrent()) return { ok: true };
      if (after.error) throw after.error;
      if (after.data.session?.user.id !== sessionUserId) {
        throw { code: "session_not_found" };
      }
      if (error) {
        setPasskeys({ ownerId: sessionUserId, items: [], refreshFailed: true });
        if (isPasskeyDisabled(error)) setPasskeyUnavailable(true);
        return authFailure(error, "accountPasskeyFailed");
      }
      setPasskeys({
        ownerId: sessionUserId,
        items: (data ?? []).map(toPasskeySummary),
        refreshFailed: false,
      });
      return { ok: true };
    } catch (error) {
      // An older read must never replace a newer list or report its failure
      // above the new account. Superseded reads have no UI outcome.
      if (!isCurrent()) return { ok: true };
      setPasskeys({ ownerId: sessionUserId, items: [], refreshFailed: true });
      return authFailure(error, "accountPasskeyFailed");
    } finally {
      if (requestId === passkeyRequestRef.current) setPasskeysLoading(false);
    }
  }, [hasSession, sessionUserId]);

  const registerPasskey = useCallback(async (): Promise<AuthActionResult> => {
    const client = getSupabaseClient();
    if (!client || !hasSession) return { ok: false };
    try {
      const { error } = await client.auth.registerPasskey();
      if (error) {
        if (isPasskeyDisabled(error)) setPasskeyUnavailable(true);
        return authFailure(error, "accountPasskeyFailed");
      }
    } catch (error) {
      return authFailure(error, "accountPasskeyFailed");
    }
    const refreshed = await listPasskeys();
    return refreshed.ok ? refreshed : { ok: false, errorKey: "accountPasskeyRefreshFailed" };
  }, [hasSession, listPasskeys]);

  // A discoverable credential carries the account, so this is the one passkey
  // call that works without a session; onAuthStateChange picks the result up.
  const signInWithPasskey = useCallback(async (): Promise<AuthActionResult> => {
    const client = getSupabaseClient();
    if (!client) return { ok: false };
    try {
      const { error } = await client.auth.signInWithPasskey();
      if (error) {
        if (isPasskeyDisabled(error)) setPasskeyUnavailable(true);
        return authFailure(error, "accountPasskeyFailed");
      }
      return { ok: true };
    } catch (error) {
      return authFailure(error, "accountPasskeyFailed");
    }
  }, []);

  const deletePasskey = useCallback(
    async (passkeyId: string): Promise<AuthActionResult> => {
      const client = getSupabaseClient();
      if (!client || !hasSession) return { ok: false };
      try {
        const { error } = await client.auth.passkey.delete({ passkeyId });
        if (error) {
          if (isPasskeyDisabled(error)) setPasskeyUnavailable(true);
          return authFailure(error, "accountPasskeyFailed");
        }
      } catch (error) {
        return authFailure(error, "accountPasskeyFailed");
      }
      const refreshed = await listPasskeys();
      return refreshed.ok ? refreshed : { ok: false, errorKey: "accountPasskeyRefreshFailed" };
    },
    [hasSession, listPasskeys],
  );

  return {
    appleEnabled: authAvailable && APPLE_ENABLED,
    authAvailable,
    consent,
    chooseConsent,
    hasSession,
    sessionEmail: activeSession?.user?.email ?? null,
    sessionUserId,
    sessionNickname: metadataNickname(activeSession),
    getAccessToken,
    signUpEmail,
    signInEmail,
    signInGoogle,
    signInApple,
    resetPassword,
    updatePassword,
    signOutLocal,
    signOutGlobal,
    redirectOutcome,
    dismissRedirectOutcome,
    passkeySupported,
    passkeyUnavailable,
    // Neither a signed-out panel nor the next account to sign in may still see
    // the previous session's passkeys, so the list is surfaced only to the
    // account it was fetched for.
    passkeys: passkeys.ownerId === sessionUserId ? passkeys.items : [],
    passkeysLoading,
    passkeysRefreshFailed: passkeys.ownerId === sessionUserId && passkeys.refreshFailed,
    registerPasskey,
    signInWithPasskey,
    listPasskeys,
    deletePasskey,
  };
}

export default useAuthSession;
