"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Session } from "@supabase/supabase-js";
import {
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
};

function serverConsentSnapshot(): ConsentChoice | null {
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
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (!authAvailable || consent !== "account") return;
    const client = getSupabaseClient();
    if (!client) return;
    let disposed = false;
    void client.auth
      .getSession()
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

  // The session is only surfaced while account mode is active; flipping the
  // consent back to local hides it without wiping auth storage.
  const activeSession =
    authAvailable && consent === "account" ? session : null;

  return {
    appleEnabled: authAvailable && APPLE_ENABLED,
    authAvailable,
    consent,
    chooseConsent,
    hasSession: activeSession !== null,
    sessionEmail: activeSession?.user?.email ?? null,
    sessionUserId: activeSession?.user?.id ?? null,
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
  };
}

export default useAuthSession;
