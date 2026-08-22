import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { GAME_COPY } from "../app/i18n.ts";

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

test("a provider redirect is completed and its code never lingers in the URL", async () => {
  const client = await readSource("../app/auth/client.ts");

  // detectSessionInUrl stays off so that constructing the client cannot touch
  // the network on its own. That makes the exchange this module's duty: without
  // it Google returns with `?code=` and the player silently stays signed out.
  assert.match(client, /detectSessionInUrl: false/);

  // supabase-js expects the code, not the whole href. Handing it the href is a
  // silent always-fails call, which is exactly the bug this consolidation ended.
  assert.equal(countMatches(client, /exchangeCodeForSession\(/g), 1);
  assert.match(client, /await client\.auth\.exchangeCodeForSession\(code\)/);

  // The query is stripped before the first await, not after it. Anything awaited
  // first leaves a redeemable credential in the address bar and in history.
  const body = client.slice(client.indexOf("async function exchangeRedirect"));
  assert.ok(
    body.indexOf("stripRedirectParams();") < body.indexOf("await client.auth"),
    "the redirect params must be stripped before the exchange is awaited",
  );

  // A cancelled consent screen is not a failure, and must not read as one — but
  // only a BARE access_denied is a cancellation. The auth server answers every
  // 403 with access_denied and names the real reason in error_code, so an
  // expired or already-used e-mail link arrives as
  // `error=access_denied&error_code=otp_expired`. Calling that "you closed the
  // sign-in window" tells a player who opened a stale link something they know
  // is untrue, so the error code has to be read before the strip removes it.
  assert.match(client, /const errorCode = params\.get\("error_code"\);/);
  assert.match(
    client,
    /error === "access_denied" && !errorCode \? "cancelled" : "failed"/,
  );
  const read = client.indexOf('params.get("error_code")');
  assert.ok(
    read > 0 && read < client.indexOf("stripRedirectParams();"),
    "error_code must be read before the query is stripped",
  );

  // Nothing about the provider's own error may reach the caller or a log.
  assert.doesNotMatch(client, /console\./);
  assert.doesNotMatch(client, /exchangeError\.(message|name|code)/);
  // error_description is the one parameter that quotes the server's own prose;
  // it is stripped and never read, so it cannot reach the player either.
  assert.doesNotMatch(client, /params\.get\("error_description"\)/);
});

test("the shared redirect promise cannot reject on the history rewrite", async () => {
  const client = await readSource("../app/auth/client.ts");

  // Two callers await this one memoised promise and page.tsx does not catch, so
  // a rejection would lose the whole outcome there — no reset dialog, no tab
  // change — on top of an unhandled rejection. The history rewrite is the only
  // statement in the strip that can raise (a sandboxed or throttled document
  // refuses it), so it is guarded and the exchange still spends the code.
  const strip = client.slice(
    client.indexOf("function stripRedirectParams"),
    client.indexOf("async function exchangeRedirect"),
  );
  assert.match(strip, /try \{\s*window\.history\.replaceState\(/);
  assert.ok(
    strip.indexOf("window.history.replaceState(") < strip.indexOf("} catch {"),
    "the rewrite must sit inside the try block",
  );
});

test("the exchange runs at most once per page load", async () => {
  const client = await readSource("../app/auth/client.ts");

  // page.tsx and useAuthSession both await this on the same load, in an order
  // neither controls, and StrictMode mounts twice. A code can be spent once, so
  // every caller has to read one settled result instead of a second exchange
  // reporting a failure that never happened.
  assert.match(
    client,
    /let pendingRedirect: Promise<AuthRedirectResult> \| null = null;/,
  );
  assert.match(client, /pendingRedirect \?\?= exchangeRedirect\(\);/);
  assert.match(client, /return pendingRedirect;/);
  assert.equal(countMatches(client, /exchangeRedirect\(\);/g), 1);

  // Only the server-render guard may answer without touching the memo.
  const entry = client.slice(
    client.indexOf("export function completeAuthRedirect"),
  );
  assert.match(
    entry.slice(0, entry.indexOf("pendingRedirect")),
    /typeof window === "undefined"/,
  );
});

test("the redirect result reports the reset flag and the requested view", async () => {
  const client = await readSource("../app/auth/client.ts");

  for (const member of [
    "kind: AuthRedirectKind;",
    "passwordReset: boolean;",
    'view: "game" | null;',
  ]) {
    assert.ok(client.includes(member), `AuthRedirectResult needs ${member}`);
  }

  // Both travel on the redirect and are read before the URL is cleaned, because
  // the callers can no longer find them there afterwards.
  assert.match(client, /const passwordReset = params\.get\("reset"\) === "1";/);
  assert.match(
    client,
    /const view = params\.get\("view"\) === "game" \? "game" : null;/,
  );

  // Everything the redirect added is removed; `lang` is not ours to remove — a
  // shared link has to keep opening in the language it was sent in.
  const stripped = client.slice(
    client.indexOf("const REDIRECT_PARAMS"),
    client.indexOf("function stripRedirectParams"),
  );
  for (const key of [
    "code",
    "state",
    "error",
    "error_code",
    "error_description",
    "reset",
    "view",
  ]) {
    assert.match(stripped, new RegExp(`"${key}",`));
  }
  assert.doesNotMatch(stripped, /"lang"/);
});

test("every provider redirect comes back to the game tab", async () => {
  const hook = await readSource("../app/auth/useAuthSession.ts");

  // The site root renders the control tab, so a player who signed in from the
  // game menu used to land two clicks away from the profile they signed in for.
  assert.match(hook, /target\.searchParams\.set\("view", "game"\);/);
  assert.match(hook, /emailRedirectTo: authRedirectTarget\(\),/);
  assert.match(hook, /redirectTo: authRedirectTarget\(\) \},/);
  assert.match(hook, /redirectTo: authRedirectTarget\(\{ reset: "1" \}\),/);

  // Built through URL/URLSearchParams: string concatenation is how the reset
  // flag and the view would end up fighting over the same `?`.
  assert.match(hook, /new URL\(window\.location\.origin\)/);
  assert.doesNotMatch(hook, /\$\{window\.location\.(origin|href)\}/);

  // A parameter the link was shared with has to survive the round trip.
  // client.ts refuses to strip `lang` precisely so a reader who copies the
  // address bar onward still gets the language it was sent in — and a target
  // rebuilt from the bare origin dropped it one step earlier, which made that
  // refusal say something untrue. Everything but the parameters a redirect owns
  // travels along, and that list stays in client.ts so the two cannot disagree.
  const target = hook.slice(
    hook.indexOf("function authRedirectTarget"),
    hook.indexOf("// ── The redirect notice"),
  );
  assert.match(target, /for \(const \[key, value\] of current\.searchParams\)/);
  assert.match(target, /if \(REDIRECT_PARAMS\.includes\(key\)\) continue;/);
  // No fragment goes back out: nothing here owns it, and an implicit-grant
  // token would.
  assert.doesNotMatch(target, /\.hash/);
});

test("the session is read only after the redirect has settled", async () => {
  const hook = await readSource("../app/auth/useAuthSession.ts");

  // On the way back from Google the session does not exist until the exchange
  // finishes; asking first pins the hook to "signed out" for the page's life.
  const settle = hook.slice(hook.indexOf("const settleRedirect = async"));
  assert.ok(
    settle.indexOf("await completeAuthRedirect()") <
      settle.indexOf("await client.auth.getSession()"),
    "getSession must be awaited after the redirect result",
  );
});

test("a failed or cancelled redirect reaches the panel and can be dismissed", async () => {
  const hook = await readSource("../app/auth/useAuthSession.ts");
  const panel = await readSource("../app/AccountPanel.tsx");

  assert.ok(hook.includes("redirectOutcome: AuthRedirectKind | null;"));
  assert.ok(hook.includes("dismissRedirectOutcome: () => void;"));
  assert.match(
    hook,
    /const dismissRedirectOutcome = useCallback\(\(\) => \{\s*retireRedirectNotice\(\);/,
  );

  // Only the two kinds the player can act on are worded; a completed sign-in and
  // an ordinary page load say nothing at all.
  assert.match(panel, /panelCopy\.accountRedirectFailed/);
  assert.match(panel, /panelCopy\.accountRedirectCancelled/);
  assert.doesNotMatch(panel, /redirectOutcome === "(none|signed-in)"/);

  // A closed provider window is a decision, not an error, so it must not be
  // announced as one either.
  assert.match(panel, /role=\{redirectFailed \? "alert" : "status"\}/);
  assert.match(panel, /onClick=\{auth\.dismissRedirectOutcome\}/);

  // The × is the only control in that box, so its accessible name is all a
  // screen-reader user gets. Borrowing the rename form's "Cancel" described
  // abandoning the sign-in rather than closing a message, right next to copy
  // that says the sign-in did not complete.
  assert.match(panel, /aria-label=\{panelCopy\.accountNoticeDismiss\}/);
  for (const language of ["uk", "de", "en"]) {
    assert.equal(
      typeof GAME_COPY[language].accountNoticeDismiss,
      "string",
      `${language} needs its own dismiss label`,
    );
  }
});

test("a dismissed redirect notice stays dismissed for the page load", async () => {
  const hook = await readSource("../app/auth/useAuthSession.ts");

  // AccountPanel is the only component that renders the notice, and it is
  // mounted and unmounted with the profile section of the game menu. Held in
  // component state, the notice came back on every later visit: the fresh
  // instance re-awaited the memoised promise in client.ts, found the same
  // settled kind and published it again — undoing the dismissal, and
  // re-announcing role="alert" each time. The state therefore belongs to the
  // page load, at module scope, where retiring it is final.
  assert.doesNotMatch(hook, /redirectPublishedRef/);
  assert.doesNotMatch(hook, /useState<AuthRedirectKind \| null>/);
  assert.match(hook, /^let redirectNotice: AuthRedirectKind \| null = null;$/m);
  assert.match(hook, /^let redirectNoticeRetired = false;$/m);
  assert.match(
    hook,
    /const redirectOutcome = useSyncExternalStore\(\s*subscribeToRedirectNotice,/,
  );

  // Retired means retired: nothing may publish over it again.
  const publish = hook.slice(
    hook.indexOf("function publishRedirectNotice"),
    hook.indexOf("function subscribeToRedirectNotice"),
  );
  assert.match(publish, /if \(redirectNoticeRetired[^)]*\) return;/);
  assert.match(publish, /redirectNoticeRetired = true;/);
});

test("a session retires the redirect notice instead of contradicting it", async () => {
  const hook = await readSource("../app/auth/useAuthSession.ts");

  // "The sign-in did not complete" must never sit above a panel that shows the
  // player signed in — which is what happened when they took the notice's own
  // advice and signed in again in the form right below it, and on the first
  // paint for anyone who opened a stale callback while already signed in.
  // Every arriving session runs through one place, so a sign-in by any route
  // retires the notice with it.
  assert.match(
    hook,
    /const applySession = \(next: Session \| null\) => \{\s*if \(next\) retireRedirectNotice\(\);\s*setSession\(next\);/,
  );
  // One writer, so no path can set a session without retiring the notice: the
  // restored session, a signed-out read, and every onAuthStateChange event.
  assert.equal(countMatches(hook, /setSession\(/g), 1);
  assert.equal(countMatches(hook, /\bapplySession\(/g), 3);

  // Published after the session is known, so a notice that would contradict the
  // panel underneath it is never painted at all.
  const settle = hook.slice(
    hook.indexOf("const settleRedirect = async"),
    hook.indexOf("void settleRedirect();"),
  );
  assert.ok(
    settle.indexOf("await client.auth.getSession()") <
      settle.indexOf("publishRedirectNotice(kind)"),
    "the notice must be published after the session is read",
  );
});

test("the redirect notice is mounted where the redirect lands", async () => {
  const gamePanel = await readSource("../app/GamePanel.tsx");
  const menu = await readSource("../app/game/GameMenu.tsx");

  // The notice lives in AccountPanel, which exists only while the profile
  // section is open — so a failed or cancelled sign-in returned to the game tab
  // and said nothing at all on the section the menu opens on. A successful one
  // arrived just as blind: that same panel IS the profile, so a player who had
  // just signed in landed on "play" with it one more click away. Every redirect
  // that happened opens the section, and only a page load without one keeps the
  // menu's default. The redirect is read from the memoised result rather than
  // from the dismissible outcome, so dismissing the notice cannot move the
  // player somewhere else.
  assert.match(gamePanel, /return kind === "none" \? null : "profile";/);
  assert.doesNotMatch(
    gamePanel,
    /redirect\.kind === "failed" \|\| redirect\.kind === "cancelled"/,
    "a redirect that did establish a session must reach the profile too",
  );
  assert.match(
    gamePanel,
    /const section = claimRedirectSection\(redirect\.kind\);/,
  );
  // Two writers, and the second one is the point: the menu is unmounted for the
  // length of a run, so a request still held when it remounts would re-open the
  // profile section after every single game. The claim sets it; starting a run
  // spends it. Clearing it from an effect is not an option — the lint rule
  // forbids setState there, which is why the menu resolves it during render.
  assert.equal(countMatches(gamePanel, /setRedirectSection\(/g), 2);
  assert.match(gamePanel, /const forgetRedirectSection = useCallback\(/);
  assert.equal(countMatches(gamePanel, /forgetRedirectSection\(\);/g), 2);
  assert.match(gamePanel, /requestedSection=\{redirectSection\}/);

  // Resolved during render, so the request never has to be copied into state:
  // the player's own choice always wins once they make one.
  assert.match(
    menu,
    /const section = chosenSection \?\? requestedSection \?\? "play";/,
  );
  assert.match(menu, /setChosenSection\(item\);/);
  assert.equal(countMatches(menu, /useState<GameMenuSection/g), 1);
});

test("a signed-in player can set a password without any e-mail", async () => {
  const panel = await readSource("../app/AccountPanel.tsx");

  // Built-in Supabase SMTP only mails project team members, so the reset link is
  // no route at all for the account this was added for. The form therefore only
  // exists where a live session already proves who is asking.
  assert.ok(
    panel.indexOf('className="account-signed-in"') <
      panel.indexOf("<SetPasswordForm"),
    "the set-password form belongs to the signed-in branch",
  );
  assert.equal(countMatches(panel, /<SetPasswordForm/g), 1);
  assert.match(panel, /await auth\.updatePassword\(nextPassword\)/);

  // One shared minimum: a password accepted here can never be one the sign-up
  // form would have refused.
  assert.match(panel, /const MIN_PASSWORD_LENGTH = 8;/);
  assert.doesNotMatch(panel, /password\.length < 8/);
  assert.equal(
    countMatches(panel, /\.length < MIN_PASSWORD_LENGTH/g),
    2,
    "sign-up and the password form must share the minimum",
  );

  // Result goes through the panel's existing aria-live region, failure through
  // its existing error presentation.
  assert.match(panel, /setNotice\(panelCopy\.accountPasswordSetSuccess\)/);
  assert.match(panel, /setErrorText\(copy\.accountPasswordTooShort\)/);
  assert.match(panel, /setErrorText\(copy\.accountAuthError\)/);

  // Deliberately no guess at whether a password already exists: nothing on the
  // session answers that reliably, and a wrong label is worse than a neutral one.
  assert.doesNotMatch(panel, /identities/);

  // The field lives in a child keyed on the account, so a typed-but-unsubmitted
  // password cannot outlive the session on a shared browser.
  assert.match(panel, /key=\{auth\.sessionUserId\}/);
  assert.match(panel, /const \[password, setPassword\] = useState\(""\);/);
});

test("submitting the set-password form does not strand keyboard focus", async () => {
  const panel = await readSource("../app/AccountPanel.tsx");
  const form = panel.slice(panel.indexOf("function SetPasswordForm"));

  // Both controls are disabled for the length of the network call, and a browser
  // blurs a disabled element to the document body: pressing Enter in the field
  // left a keyboard player with no focus at all, tabbing again from the top of
  // the document — on the one password route a Google-created account has.
  assert.match(form, /ref=\{submitRef\}/);
  assert.match(form, /const cameBack = wasDisabledRef\.current && !disabled;/);
  assert.match(form, /document\.activeElement !== document\.body/);
  assert.match(form, /submitRef\.current\?\.focus\(\);/);
});
