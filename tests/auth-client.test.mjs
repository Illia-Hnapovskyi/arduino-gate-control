import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The auth client layer is browser-only (React hooks, WebAuthn, Supabase
// storage), so it is pinned at the source level like the rendered-artifact
// tests rather than executed here.
function readSource(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function hookCallbackSource(source, name) {
  const start = source.indexOf(`const ${name} = useCallback(`);
  assert.ok(start > -1, `${name} must be declared as a useCallback`);
  const rest = source.slice(start + 1);
  const nextDeclaration = rest.indexOf("\n  const ");
  const hookReturn = rest.indexOf("\n  return {");
  const end =
    nextDeclaration > -1 && (hookReturn === -1 || nextDeclaration < hookReturn)
      ? nextDeclaration
      : hookReturn;
  assert.ok(end > -1, `${name} must be followed by the rest of the hook`);
  return rest.slice(0, end);
}

test("the Supabase client opts into passkeys inside its auth options", async () => {
  const source = await readSource("../app/auth/client.ts");

  const constructionIndex = source.indexOf("createClient(SUPABASE_URL");
  assert.ok(constructionIndex > -1, "the client must be constructed once");
  const construction = source.slice(constructionIndex);

  assert.match(construction, /experimental: \{ passkey: true \}/);
  assert.ok(
    construction.indexOf("auth: {") < construction.indexOf("experimental:"),
    "the experimental flag belongs to the auth options object",
  );
  assert.match(construction, /flowType: "pkce"/);
  assert.match(construction, /detectSessionInUrl: false/);
});

test("the Supabase client is still built lazily behind the consent check", async () => {
  const source = await readSource("../app/auth/client.ts");

  const lazyGetterIndex = source.indexOf("export function getSupabaseClient");
  const constructionIndex = source.indexOf("createClient(SUPABASE_URL");
  assert.ok(
    lazyGetterIndex > -1 && lazyGetterIndex < constructionIndex,
    "construction must happen inside getSupabaseClient, not at module load",
  );
  assert.equal(countMatches(source, /createClient\(/g), 1);

  const guards = source.slice(lazyGetterIndex, constructionIndex);
  assert.match(guards, /if \(!authAvailable \|\| typeof window === "undefined"\)/);
  assert.match(guards, /if \(readConsentChoice\(\) !== "account"\) return null;/);

  assert.doesNotMatch(source, /document\.cookie/);
});

test("no Supabase or passkey call happens while the modules load", async () => {
  const clientSource = await readSource("../app/auth/client.ts");
  const hookSource = await readSource("../app/auth/useAuthSession.ts");

  const clientTopLevel = clientSource.slice(
    0,
    clientSource.indexOf("export function readConsentChoice"),
  );
  assert.doesNotMatch(clientTopLevel, /createClient\(|\.auth\./);

  const hookTopLevel = hookSource.slice(
    0,
    hookSource.indexOf("export function useAuthSession"),
  );
  assert.doesNotMatch(hookTopLevel, /getSupabaseClient\(\)|\.auth\./);

  // Listing passkeys is a network call the panel triggers on demand. Every
  // effect is declared above it, so no effect can even reference it.
  const lastEffectIndex = hookSource.lastIndexOf("useEffect(");
  assert.ok(lastEffectIndex > -1, "the hook still subscribes through an effect");
  assert.ok(
    lastEffectIndex < hookSource.indexOf("const listPasskeys = useCallback("),
    "listPasskeys must be declared after every effect",
  );
  assert.ok(
    lastEffectIndex < hookSource.indexOf("client.auth.passkey"),
    "no passkey request may be issued from an effect",
  );
  assert.equal(countMatches(hookSource, /client\.auth\.passkey\.list\(\)/g), 1);
});

test("a disabled passkey project degrades instead of surfacing a raw error", async () => {
  const source = await readSource("../app/auth/useAuthSession.ts");

  assert.match(source, /const PASSKEY_DISABLED_CODE = "passkey_disabled";/);
  assert.match(source, /error\.code === PASSKEY_DISABLED_CODE/);

  // Only the disabled toggle is remembered; a dismissed WebAuthn prompt must
  // leave passkeyUnavailable alone.
  assert.match(source, /NotAllowedError\/AbortError/);
  const guardedFlips = countMatches(
    source,
    /if \(isPasskeyDisabled\(error\)\) setPasskeyUnavailable\(true\);/g,
  );
  assert.equal(guardedFlips, 4);
  assert.equal(
    countMatches(source, /setPasskeyUnavailable\(true\)/g),
    guardedFlips,
  );
  assert.doesNotMatch(source, /setPasskeyUnavailable\(false\)/);

  // Nothing about a token, an e-mail or a credential may reach the UI or a log.
  assert.doesNotMatch(source, /console\./);
  assert.doesNotMatch(source, /error\.message|error\.name/);
});

test("the passkey surface matches the panel contract", async () => {
  const source = await readSource("../app/auth/useAuthSession.ts");

  for (const member of [
    "passkeySupported: boolean;",
    "passkeyUnavailable: boolean;",
    "passkeys: PasskeySummary[];",
    "passkeysLoading: boolean;",
    "registerPasskey: () => Promise<AuthActionResult>;",
    "signInWithPasskey: () => Promise<AuthActionResult>;",
    "listPasskeys: () => Promise<AuthActionResult>;",
    "deletePasskey: (passkeyId: string) => Promise<AuthActionResult>;",
  ]) {
    assert.ok(source.includes(member), `UseAuthSessionResult needs ${member}`);
  }

  // Browser capability is derived through the SSR-safe store the file already
  // uses for the consent choice.
  assert.match(
    source,
    /typeof window !== "undefined" &&\s+typeof window\.PublicKeyCredential === "function"/,
  );
  assert.match(source, /serverPasskeySupportSnapshot/);

  // Supabase answers in snake_case and omits the optional fields.
  assert.match(source, /friendlyName: item\.friendly_name \?\? null/);
  assert.match(source, /lastUsedAt: item\.last_used_at \?\? null/);

  for (const name of ["registerPasskey", "listPasskeys", "deletePasskey"]) {
    assert.match(
      hookCallbackSource(source, name),
      /if \(!client \|\| !hasSession\) return \{ ok: false \};/,
      `${name} requires an active session`,
    );
  }
  // Sign-in uses a discoverable credential, so it must work without a session.
  const signIn = hookCallbackSource(source, "signInWithPasskey");
  assert.match(signIn, /if \(!client\) return \{ ok: false \};/);
  assert.doesNotMatch(signIn, /hasSession/);

  // A fresh registration or deletion re-reads the list instead of guessing.
  for (const name of ["registerPasskey", "deletePasskey"]) {
    assert.match(hookCallbackSource(source, name), /await listPasskeys\(\);/);
  }
});

test("a fetched passkey list never outlives the account it belongs to", async () => {
  const source = await readSource("../app/auth/useAuthSession.ts");

  // Nothing in the panel unmounts on sign-out, so the list survives a
  // sign-out/sign-in cycle. Masking it on hasSession alone would let the next
  // account render — and press delete on — the previous account's credentials
  // while its own refresh is still in flight, or forever if that refresh fails.
  assert.match(
    source,
    /useState<\{\s*ownerId: string \| null;\s*items: PasskeySummary\[\];\s*\}>\(\{ ownerId: null, items: \[\] \}\)/,
  );
  assert.match(
    source,
    /passkeys: passkeys\.ownerId === sessionUserId \? passkeys\.items : \[\]/,
  );
  assert.doesNotMatch(source, /passkeys: hasSession \? passkeys : \[\]/);

  // Only a successful list writes the pair, and it records who it was for.
  assert.equal(countMatches(source, /setPasskeys\(/g), 1);
  assert.match(source, /setPasskeys\(\{\s*ownerId: sessionUserId,/);
});
