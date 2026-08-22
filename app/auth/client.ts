"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL,
  authAvailable,
} from "./supabaseConfig";

// ── Consent (cookieless, localStorage only) ──────────────────────────────
// The Supabase client must never be constructed — and therefore never touch
// storage or the network — before the player explicitly chose account mode.

export type ConsentChoice = "local" | "account";

const CONSENT_STORAGE_KEY = "arduino-gate-consent:v1";
const CONSENT_EVENT = "arduino-gate-consent-change";

export function readConsentChoice(): ConsentChoice | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { choice?: unknown } | null;
    if (parsed?.choice === "account") return "account";
    if (parsed?.choice === "local") return "local";
    return null;
  } catch {
    return null;
  }
}

export function saveConsentChoice(choice: ConsentChoice) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ choice, decidedAt: new Date().toISOString() }),
    );
  } catch {
    // Private-mode storage failures fall back to a session-local default.
  }
  window.dispatchEvent(new Event(CONSENT_EVENT));
}

export function subscribeToConsentChoice(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === CONSENT_STORAGE_KEY) callback();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CONSENT_EVENT, callback);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CONSENT_EVENT, callback);
  };
}

// ── Lazy Supabase client ──────────────────────────────────────────────────
// No network or storage access happens at module load; the singleton is only
// created on first use, and only when the key is configured AND the player
// consented to account mode.

let cachedClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (!authAvailable || typeof window === "undefined") return null;
  if (readConsentChoice() !== "account") return null;
  if (!cachedClient) {
    cachedClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        flowType: "pkce",
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        // Supabase still ships the passkey API behind this opt-in; without it
        // every passkey call throws instead of reaching the server, which then
        // reports whether the project toggle is on.
        experimental: { passkey: true },
      },
    });
  }
  return cachedClient;
}

// ── Completing a provider redirect ────────────────────────────────────────
// The client is built with detectSessionInUrl disabled so that constructing it
// never touches the network or storage on its own. That makes finishing the
// PKCE round trip this module's job: the provider returns to the page with
// `?code=`, and without an explicit exchange the player simply lands back on
// the site still signed out, with no error to explain why.

export type AuthRedirectKind = "none" | "signed-in" | "cancelled" | "failed";

export type AuthRedirectResult = {
  kind: AuthRedirectKind;
  /** The redirect carried `reset=1`: the player asked for a new password. */
  passwordReset: boolean;
  /** The redirect asked to land on the game tab rather than the site root. */
  view: "game" | null;
};

// `lang` is deliberately NOT in this list. The whole point of that parameter is
// a link the user can paste into a job application, so it has to survive the
// round trip and stay in the address bar for whoever copies it onward. That is
// only true if the target sent out keeps it too, so `authRedirectTarget()` in
// useAuthSession carries over every current parameter except exactly this list.
export const REDIRECT_PARAMS = [
  "code",
  "state",
  "error",
  "error_code",
  "error_description",
  "reset",
  "view",
];

function stripRedirectParams() {
  const url = new URL(window.location.href);
  let touched = false;
  for (const key of REDIRECT_PARAMS) {
    if (!url.searchParams.has(key)) continue;
    url.searchParams.delete(key);
    touched = true;
  }
  if (!touched) return;
  const query = url.searchParams.toString();
  try {
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${query ? `?${query}` : ""}${url.hash}`,
    );
  } catch {
    // The rewrite is the only statement here that can raise — a sandboxed or
    // throttled document refuses it — and the memoised promise must not reject:
    // page.tsx awaits it without a catch and would lose the whole outcome.
    // Continuing is also the safer half of the trade, because the exchange still
    // spends the code that this failed to remove from the address bar.
  }
}

async function exchangeRedirect(): Promise<AuthRedirectResult> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const error = params.get("error");
  const errorCode = params.get("error_code");
  const passwordReset = params.get("reset") === "1";
  const view = params.get("view") === "game" ? "game" : null;

  // Strip before the first await. An authorization code left in the address bar
  // survives in history, gets copied into a chat message with the rest of the
  // URL, and stays redeemable until it is spent. Every value the callers need is
  // captured above, so nothing is lost by clearing the query this early.
  stripRedirectParams();

  if (error) {
    // A closed provider window is the player changing their mind, not a fault,
    // and the two stay distinguishable all the way to the notice in the panel.
    // But `access_denied` is also what the auth server relays for every refusal
    // it answers with 403 — an expired or already-used e-mail link arrives as
    // `access_denied` plus `error_code=otp_expired`. Only a bare `access_denied`
    // may therefore claim the window was closed; a named error code is a
    // server-side refusal, and telling a player who opened a stale link that
    // they closed a window they never saw states something untrue. Reading "did
    // not complete" after a real cancellation is the harmless half of the trade.
    return {
      kind: error === "access_denied" && !errorCode ? "cancelled" : "failed",
      passwordReset,
      view,
    };
  }
  if (!code) return { kind: "none", passwordReset, view };
  const client = getSupabaseClient();
  if (!client) return { kind: "failed", passwordReset, view };
  try {
    const { error: exchangeError } =
      await client.auth.exchangeCodeForSession(code);
    // The Supabase error is intentionally dropped: it names the grant and the
    // provider, and the player can do nothing with either.
    return {
      kind: exchangeError ? "failed" : "signed-in",
      passwordReset,
      view,
    };
  } catch {
    return { kind: "failed", passwordReset, view };
  }
}

// An authorization code can be spent exactly once, and both page.tsx and
// useAuthSession await this on the same page load in an order neither of them
// controls. The memoised promise makes every later caller — a re-run effect and
// StrictMode's second mount included — read the one settled result instead of
// re-running the exchange against an already spent code and reporting a failure
// that never happened.
let pendingRedirect: Promise<AuthRedirectResult> | null = null;

export function completeAuthRedirect(): Promise<AuthRedirectResult> {
  if (typeof window === "undefined") {
    return Promise.resolve({ kind: "none", passwordReset: false, view: null });
  }
  pendingRedirect ??= exchangeRedirect();
  return pendingRedirect;
}

// Standalone token provider for useGameStats({ getAccessToken }) — usable
// outside React. Returns null whenever account mode is unavailable, so the
// legacy access-code sync path stays untouched.
export async function getSupabaseAccessToken(): Promise<string | null> {
  const client = getSupabaseClient();
  if (!client) return null;
  try {
    const { data } = await client.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}
