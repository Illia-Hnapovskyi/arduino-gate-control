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

export type AuthRedirectOutcome = "none" | "signed-in" | "cancelled" | "failed";

const REDIRECT_PARAMS = [
  "code",
  "state",
  "error",
  "error_code",
  "error_description",
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
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${query ? `?${query}` : ""}${url.hash}`,
  );
}

export async function completeAuthRedirect(): Promise<AuthRedirectOutcome> {
  if (typeof window === "undefined") return "none";
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const error = params.get("error");
  if (!code && !error) return "none";

  // Strip before the first await. An authorization code left in the address bar
  // survives in history, gets copied into a chat message with the rest of the
  // URL, and stays redeemable until it is spent. Both values are captured above.
  stripRedirectParams();

  if (error) return error === "access_denied" ? "cancelled" : "failed";
  const client = getSupabaseClient();
  if (!client || !code) return "failed";
  try {
    const { error: exchangeError } =
      await client.auth.exchangeCodeForSession(code);
    return exchangeError ? "failed" : "signed-in";
  } catch {
    return "failed";
  }
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
