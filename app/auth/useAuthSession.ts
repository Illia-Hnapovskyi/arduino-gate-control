"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { PasskeyListItem, Session } from "@supabase/supabase-js";
import {
  completeAuthRedirect,
  getSupabaseAccessToken,
  getSupabaseClient,
  readConsentChoice,
  saveConsentChoice,
  subscribeToConsentChoice,
  type ConsentChoice,
} from "./client";
import { APPLE_ENABLED, authAvailable } from "./supabaseConfig";

export type AuthActionResult = { ok: boolean };

export type AuthSignUpResult = {
  ok: boolean;
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
  passkeySupported: boolean;
  passkeyUnavailable: boolean;
  passkeys: PasskeySummary[];
  passkeysLoading: boolean;
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
  const [passkeyUnavailable, setPasskeyUnavailable] = useState(false);
  // A fetched list belongs to exactly one account, so it is stored with the
  // owner it was fetched for. Nothing here unmounts on sign-out, so without the
  // owner the next account would inherit the previous one's credentials.
  const [passkeys, setPasskeys] = useState<{
    ownerId: string | null;
    items: PasskeySummary[];
  }>({ ownerId: null, items: [] });
  const [passkeysLoading, setPasskeysLoading] = useState(false);

  useEffect(() => {
    if (!authAvailable || consent !== "account") return;
    const client = getSupabaseClient();
    if (!client) return;
    let disposed = false;
    // Finish any provider redirect before reading the session: on the way back
    // from Google the session does not exist yet, and asking first would settle
    // this hook on "signed out" for the rest of the page's life.
    void completeAuthRedirect()
      .catch(() => "failed" as const)
      .then(() => client.auth.getSession())
      .then(({ data }) => {
        if (!disposed) setSession(data.session);
      })
      .catch(() => {
        if (!disposed) setSession(null);
      });
    const { data: subscription } = client.auth.onAuthStateChange(
      (_event, nextSession) => {
        if (!disposed) setSession(nextSession);
      },
    );
    return () => {
      disposed = true;
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
            emailRedirectTo: window.location.origin,
            data: { nickname },
          },
        });
        if (error) return { ok: false, needsConfirmation: false };
        return { ok: true, needsConfirmation: data.session === null };
      } catch {
        return { ok: false, needsConfirmation: false };
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
        return { ok: !error };
      } catch {
        return { ok: false };
      }
    },
    [],
  );

  const signInWithProvider = useCallback(
    async (provider: "google" | "apple"): Promise<AuthActionResult> => {
      const client = getSupabaseClient();
      if (!client) return { ok: false };
      try {
        const { error } = await client.auth.signInWithOAuth({
          provider,
          options: { redirectTo: window.location.origin },
        });
        return { ok: !error };
      } catch {
        return { ok: false };
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
          redirectTo: `${window.location.origin}?reset=1`,
        });
        return { ok: !error };
      } catch {
        return { ok: false };
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
        return { ok: !error };
      } catch {
        return { ok: false };
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
        return { ok: !error };
      } catch {
        return { ok: false };
      }
    },
    [],
  );

  const signOutLocal = useCallback(() => signOut("local"), [signOut]);
  const signOutGlobal = useCallback(() => signOut("global"), [signOut]);

  // Listing is a network call the panel triggers when its passkey section
  // becomes visible; it never runs on mount.
  const listPasskeys = useCallback(async (): Promise<AuthActionResult> => {
    const client = getSupabaseClient();
    if (!client || !hasSession) return { ok: false };
    setPasskeysLoading(true);
    try {
      const { data, error } = await client.auth.passkey.list();
      if (error) {
        if (isPasskeyDisabled(error)) setPasskeyUnavailable(true);
        return { ok: false };
      }
      setPasskeys({
        ownerId: sessionUserId,
        items: (data ?? []).map(toPasskeySummary),
      });
      return { ok: true };
    } catch {
      return { ok: false };
    } finally {
      setPasskeysLoading(false);
    }
  }, [hasSession, sessionUserId]);

  const registerPasskey = useCallback(async (): Promise<AuthActionResult> => {
    const client = getSupabaseClient();
    if (!client || !hasSession) return { ok: false };
    try {
      const { error } = await client.auth.registerPasskey();
      if (error) {
        if (isPasskeyDisabled(error)) setPasskeyUnavailable(true);
        return { ok: false };
      }
    } catch {
      return { ok: false };
    }
    await listPasskeys();
    return { ok: true };
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
        return { ok: false };
      }
      return { ok: true };
    } catch {
      return { ok: false };
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
          return { ok: false };
        }
      } catch {
        return { ok: false };
      }
      await listPasskeys();
      return { ok: true };
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
    passkeySupported,
    passkeyUnavailable,
    // Neither a signed-out panel nor the next account to sign in may still see
    // the previous session's passkeys, so the list is surfaced only to the
    // account it was fetched for.
    passkeys: passkeys.ownerId === sessionUserId ? passkeys.items : [],
    passkeysLoading,
    registerPasskey,
    signInWithPasskey,
    listPasskeys,
    deletePasskey,
  };
}

export default useAuthSession;
