// Supabase JWT verification for /api/stats bearer requests.
//
// This helper lives outside api/ on purpose: every file in api/ becomes a
// Vercel endpoint, so shared server-only logic must be imported from here
// (with the same explicit .js specifier rule as shared/gameStats.js).
//
// Verification is done with node:crypto only — no new dependencies — against
// the public JWKS of the Supabase project. Error messages never include the
// token or any of its claims.

import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

const SUPABASE_ISSUER = "https://vullhduhswcnlpgnlrtp.supabase.co/auth/v1";
const JWKS_URL = `${SUPABASE_ISSUER}/.well-known/jwks.json`;
const JWKS_CACHE_TTL_MS = 10 * 60_000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 8_192;

const BASE64URL_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type VerifiedAuth = { userId: string; sessionId: string | null };

export type AuthVerifyResult =
  | { ok: true; auth: VerifiedAuth }
  | { ok: false; status: 401 | 503; code: string; error: string };

type JwksDocument = { keys: unknown[] };

type JwkCandidate = Record<string, unknown>;

let cachedJwks: { fetchedAt: number; keys: unknown[] } | null = null;
let inFlightJwks: Promise<JwksDocument | null> | null = null;
let testJwks: JwksDocument | null = null;

// Test seam: overrides both the fetch and the module-scope cache. Passing null
// restores normal behavior (and clears the cache so the next call refetches).
export function __setJwksForTesting(jwks: JwksDocument | null): void {
  testJwks = jwks;
  cachedJwks = null;
  inFlightJwks = null;
}

function invalidToken(error: string): AuthVerifyResult {
  return { ok: false, status: 401, code: "AUTH_TOKEN_INVALID", error };
}

function keysUnavailable(): AuthVerifyResult {
  return {
    ok: false,
    status: 503,
    code: "AUTH_KEYS_UNAVAILABLE",
    error: "Authentication keys are temporarily unavailable.",
  };
}

// A failed (or timed-out) fetch leaves the cache empty on purpose: callers map
// null to 503 AUTH_KEYS_UNAVAILABLE and the next request retries instead of
// serving a poisoned cache entry.
async function fetchJwks(): Promise<JwksDocument | null> {
  try {
    const response = await fetch(JWKS_URL, {
      headers: { accept: "application/json" },
      // Bounded wait: an unresponsive JWKS endpoint must not hold the request
      // (and its function invocation) open indefinitely.
      signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray((body as { keys?: unknown }).keys)
    ) {
      return null;
    }
    cachedJwks = { fetchedAt: Date.now(), keys: (body as JwksDocument).keys };
    return { keys: cachedJwks.keys };
  } catch {
    return null;
  }
}

async function getJwks(): Promise<JwksDocument | null> {
  if (testJwks) return testJwks;

  const now = Date.now();
  if (cachedJwks && now - cachedJwks.fetchedAt < JWKS_CACHE_TTL_MS) {
    return { keys: cachedJwks.keys };
  }

  // The in-flight promise is memoised so concurrent cache misses share a single
  // request instead of stampeding the JWKS endpoint.
  inFlightJwks ??= fetchJwks().finally(() => {
    inFlightJwks = null;
  });
  return inFlightJwks;
}

function decodeSegment(segment: string): unknown {
  const json = Buffer.from(segment, "base64url").toString("utf8");
  return JSON.parse(json) as unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Algorithm-confusion fix: a JWK is only usable when its key type matches the
// header algorithm exactly, and any advertised jwk.alg agrees. "oct" (or any
// other kty) is rejected outright so an HMAC secret can never be interpreted
// as a public key.
function jwkMatchesAlgorithm(jwk: JwkCandidate, alg: "ES256" | "RS256") {
  if (jwk.kty === "EC") {
    return (
      jwk.crv === "P-256" &&
      alg === "ES256" &&
      (jwk.alg === undefined || jwk.alg === "ES256")
    );
  }
  if (jwk.kty === "RSA") {
    return alg === "RS256" && (jwk.alg === undefined || jwk.alg === "RS256");
  }
  return false;
}

function audienceContainsAuthenticated(aud: unknown) {
  if (typeof aud === "string") return aud === "authenticated";
  return Array.isArray(aud) && aud.includes("authenticated");
}

export async function verifySupabaseToken(
  token: string,
): Promise<AuthVerifyResult> {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    return invalidToken("The bearer token is malformed.");
  }

  const segments = token.split(".");
  if (
    segments.length !== 3 ||
    segments.some((segment) => !BASE64URL_SEGMENT_PATTERN.test(segment))
  ) {
    return invalidToken("The bearer token is malformed.");
  }

  let header: unknown;
  let payload: unknown;
  try {
    header = decodeSegment(segments[0]);
    payload = decodeSegment(segments[1]);
  } catch {
    return invalidToken("The bearer token is malformed.");
  }
  if (!isPlainObject(header) || !isPlainObject(payload)) {
    return invalidToken("The bearer token is malformed.");
  }

  const alg = header.alg;
  if (alg !== "ES256" && alg !== "RS256") {
    return invalidToken("The bearer token uses an unsupported algorithm.");
  }
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    return invalidToken("The bearer token is missing a key identifier.");
  }

  const jwks = await getJwks();
  if (!jwks) return keysUnavailable();

  const jwk = jwks.keys.find(
    (candidate): candidate is JwkCandidate =>
      isPlainObject(candidate) && candidate.kid === header.kid,
  );
  if (!jwk) {
    return invalidToken("The bearer token key is unknown.");
  }
  if (!jwkMatchesAlgorithm(jwk, alg)) {
    return invalidToken("The bearer token key does not match its algorithm.");
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
  } catch {
    return invalidToken("The bearer token key is unusable.");
  }

  const signingInput = Buffer.from(`${segments[0]}.${segments[1]}`, "utf8");
  const signature = Buffer.from(segments[2], "base64url");
  let signatureValid = false;
  try {
    signatureValid =
      alg === "ES256"
        ? verifySignature(
            "sha256",
            signingInput,
            { key: publicKey, dsaEncoding: "ieee-p1363" },
            signature,
          )
        : verifySignature("sha256", signingInput, publicKey, signature);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return invalidToken("The bearer token signature is invalid.");
  }

  if (payload.iss !== SUPABASE_ISSUER) {
    return invalidToken("The bearer token issuer is not accepted.");
  }
  if (!audienceContainsAuthenticated(payload.aud)) {
    return invalidToken("The bearer token audience is not accepted.");
  }

  const nowSeconds = Date.now() / 1_000;
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return invalidToken("The bearer token expiry is missing.");
  }
  if (nowSeconds > payload.exp + CLOCK_SKEW_SECONDS) {
    return {
      ok: false,
      status: 401,
      code: "AUTH_TOKEN_EXPIRED",
      error: "The bearer token has expired.",
    };
  }
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf)) {
      return invalidToken("The bearer token is not valid yet.");
    }
    if (nowSeconds < payload.nbf - CLOCK_SKEW_SECONDS) {
      return invalidToken("The bearer token is not valid yet.");
    }
  }

  if (typeof payload.sub !== "string" || !UUID_PATTERN.test(payload.sub)) {
    return invalidToken("The bearer token subject is invalid.");
  }

  // Supabase anonymous users carry role=authenticated, so the audience does
  // not filter them — this claim is the only discriminator. Anything other
  // than an explicit false (or an absent claim) is rejected.
  if (payload.is_anonymous !== false && payload.is_anonymous !== undefined) {
    return invalidToken("Anonymous sessions cannot use account features.");
  }

  return {
    ok: true,
    auth: {
      userId: payload.sub,
      sessionId:
        typeof payload.session_id === "string" ? payload.session_id : null,
    },
  };
}
