import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

import { authFailure } from "../app/auth/errors.ts";
import { GAME_COPY } from "../app/i18n.ts";
import { GameStatsClientError, readAccessTokenSubject } from "../app/useGameStats.ts";
import * as sharedGameStats from "../shared/gameStats.ts";

// Execute the real browser client with an isolated window and a mocked network.
// No account, credential or mail is created by these regression tests.
const source = await readFile(new URL("../app/auth/client.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const hookSource = await readFile(new URL("../app/auth/useAuthSession.ts", import.meta.url), "utf8");
const compiledHook = ts.transpileModule(hookSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const panelSource = await readFile(new URL("../app/AccountPanel.tsx", import.meta.url), "utf8");
const compiledPanel = ts.transpileModule(panelSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function actionHarness({ session = null, error = null, appleEnabled = false,
  providerAvailable = true, responses = {} } = {}) {
  const calls = [];
  const stateWrites = [];
  const state = [];
  const refs = [];
  const effects = [];
  let sessionListener;
  const sdkAction = (name, data = null) => async (...args) => {
    calls.push({ name, args });
    const response = responses[name];
    return typeof response === "function" ? response(...args) :
      response ?? { data: typeof data === "function" ? data() : data, error };
  };
  const auth = {
    getSession: sdkAction("session", () => ({ session })),
    onAuthStateChange: (listener) => {
      sessionListener = listener;
      return { data: { subscription: { unsubscribe() {} } } };
    },
    signUp: sdkAction("signup", { session }),
    signInWithPassword: sdkAction("password"),
    signInWithOAuth: sdkAction("oauth"),
    resetPasswordForEmail: sdkAction("reset"),
    updateUser: sdkAction("update"),
    signOut: sdkAction("signout"),
    registerPasskey: sdkAction("passkey-register"),
    signInWithPasskey: sdkAction("passkey-signin"),
    passkey: { list: sdkAction("passkey-list", []), delete: sdkAction("passkey-delete") },
  };
  const exports = {};
  let stateIndex = 0;
  let refIndex = 0;
  vm.runInNewContext(compiledHook, {
    exports, window: { location: new URL("https://example.test/?lang=de&code=old-code#old-fragment"),
      PublicKeyCredential: class {} }, URL,
    require(name) {
      if (name === "./errors") return { authFailure };
      if (name === "./supabaseConfig") return { APPLE_ENABLED: appleEnabled, authAvailable: true };
      if (name === "./client") return {
        readConsentChoice: () => "account",
        completeAuthRedirect: async () => ({ kind: "none" }),
        subscribeToConsentChoice: () => () => {},
        getSupabaseClient: () => ({ auth }),
        REDIRECT_PARAMS: ["code", "state", "error", "reset", "view"],
        checkOAuthProvider: async (provider) => {
          calls.push({ name: "availability", args: [provider] });
          return providerAvailable ? { ok: true } : { ok: false, errorKey: "accountProviderUnavailable" };
        },
      };
      assert.equal(name, "react");
      return {
        useCallback: (callback) => callback,
        useEffect: (effect) => { effects.push(effect); },
        useRef: (initial) => { const index = refIndex++; return refs[index] ??= { current: initial }; },
        useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
        useState: (initial) => {
          const index = stateIndex++;
          if (!(index in state)) state[index] = index === 0 ? session : initial;
          return [state[index], (value) => {
            stateWrites.push({ index, value });
            state[index] = typeof value === "function" ? value(state[index]) : value;
          }];
        },
      };
    },
  });
  const render = () => {
    stateIndex = 0; refIndex = 0; effects.length = 0;
    return exports.useAuthSession();
  };
  return { hook: render(), calls, stateWrites, render,
    runEffects: () => effects.map((effect) => effect()),
    changeSession: (next) => { session = next; sessionListener("SIGNED_IN", next); },
  };
}

function panelHarness({ auth, request = async () => Response.json({ profile: {} }) }) {
  const state = [];
  const refs = [];
  const effects = [];
  const cleanups = [];
  const calls = [];
  const adopted = [];
  const exports = {};
  let stateIndex = 0;
  let refIndex = 0;
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(compiledPanel, {
    exports, AbortSignal,
    window: { confirm: () => true },
    fetch: async (...args) => { calls.push(args); return request(...args); },
    require(name) {
      if (name === "../shared/gameStats") return sharedGameStats;
      if (name === "./useGameStats") return { GameStatsClientError, readAccessTokenSubject };
      if (name === "./auth/useAuthSession") return { useAuthSession: () => ({ ...auth }) };
      if (name === "./i18n") return { GAME_COPY };
      if (name === "./ConsentPanel") return { default: () => null };
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      assert.equal(name, "react");
      return {
        useCallback: (callback) => callback,
        useEffect: (effect) => { effects.push(effect); },
        useId: () => "test-field",
        useRef: (initial) => { const index = refIndex++; return refs[index] ??= { current: initial }; },
        useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
        useState: (initial) => {
          const index = stateIndex++;
          if (!(index in state)) state[index] = initial;
          return [state[index], (value) => {
            state[index] = typeof value === "function" ? value(state[index]) : value;
          }];
        },
      };
    },
  });
  const render = () => {
    stateIndex = 0;
    refIndex = 0;
    effects.length = 0;
    return exports.AccountPanel({ copy: GAME_COPY.en, language: "en",
      stats: { profiles: [], adoptSessionProfile: (...args) => { adopted.push(args); } } });
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { render, adopted, calls, flush, runEffects: async () => {
    for (const effect of effects) cleanups.push(effect());
    await flush();
  }, unmount: () => { for (const cleanup of cleanups) cleanup?.(); } };
}

function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== "object" || !tree.props) return [];
  return [tree, ...elements(tree.props.children)];
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixtureToken(ownerId) {
  return `header.${Buffer.from(JSON.stringify({ sub: ownerId })).toString("base64url")}.signature`;
}

function clientHarness({ href = "https://example.test/", consent = null,
  writesFail = false, readsFail = false, historyFails = false,
  exchangeError = null, request = async () => Response.json({ external: { google: true, apple: false } }),
} = {}) {
  const stored = new Map();
  if (consent) stored.set("arduino-gate-consent:v1", JSON.stringify({ choice: consent }));
  const window = new EventTarget();
  window.location = new URL(href);
  window.localStorage = {
    getItem(key) {
      if (readsFail) throw new Error("Storage reads refused");
      return stored.get(key) ?? null;
    },
    setItem(key, value) {
      if (writesFail) throw new Error("Storage writes refused");
      stored.set(key, value);
    },
  };
  window.history = { replaceState(_state, _unused, next) {
    if (historyFails) throw new Error("History refused");
    window.location = new URL(next, window.location);
  } };
  const calls = { clients: 0, exchanges: [], requests: [] };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, window, URL, URLSearchParams, Event, AbortSignal,
    fetch: async (...args) => { calls.requests.push(args); return request(...args); },
    require(name) {
      if (name === "./errors") return { authFailure };
      if (name === "./supabaseConfig") return {
        authAvailable: true,
        SUPABASE_URL: "https://auth.example.test",
        SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      };
      assert.equal(name, "@supabase/supabase-js");
      return { createClient() {
        calls.clients += 1;
        return { auth: { exchangeCodeForSession: async (code) => {
          calls.exchanges.push({ code, href: window.location.href });
          return { error: exchangeError };
        } } };
      } };
    },
  });
  return { client: exports, window, stored, calls };
}

test("consent gates all auth activity and survives refused storage writes", async () => {
  const { client, window, stored, calls } = clientHarness({ consent: "local", writesFail: true });
  assert.equal(client.getSupabaseClient(), null);
  assert.equal((await client.checkOAuthProvider("google")).ok, false);
  assert.equal(calls.clients, 0);
  assert.equal(calls.requests.length, 0);
  client.saveConsentChoice("account");
  assert.equal(client.readConsentChoice(), "account");
  assert.ok(client.getSupabaseClient());
  let notifications = 0;
  const unsubscribe = client.subscribeToConsentChoice(() => { notifications += 1; });
  stored.set("arduino-gate-consent:v1", JSON.stringify({ choice: "local" }));
  const storage = new Event("storage");
  storage.key = "arduino-gate-consent:v1";
  window.dispatchEvent(storage);
  assert.equal(notifications, 1);
  assert.equal(client.readConsentChoice(), "local");
  assert.equal(client.getSupabaseClient(), null);
  unsubscribe();
});

test("consent remains usable even when both reading and writing storage throw", () => {
  const { client } = clientHarness({ readsFail: true, writesFail: true });
  assert.equal(client.readConsentChoice(), null);
  client.saveConsentChoice("account");
  assert.equal(client.readConsentChoice(), "account");
  client.saveConsentChoice("local");
  assert.equal(client.readConsentChoice(), "local");
});

test("PKCE exchanges once, strips first, preserves language and returns the reset intent", async () => {
  const { client, calls, window } = clientHarness({ consent: "account",
    href: "https://example.test/?lang=de&view=game&reset=1&code=synthetic-code#help" });
  const one = client.completeAuthRedirect();
  const two = client.completeAuthRedirect();
  assert.equal(one, two);
  const result = await one;
  assert.equal(result.kind, "signed-in");
  assert.equal(result.passwordReset, true);
  assert.equal(result.view, "game");
  assert.equal(calls.exchanges.length, 1);
  assert.equal(calls.exchanges[0].code, "synthetic-code");
  assert.equal(calls.exchanges[0].href, "https://example.test/?lang=de#help");
  assert.equal(window.location.search, "?lang=de");
});

test("fragment-based expired email links are failures and bare cancellation stays neutral", async () => {
  for (const [fragment, kind] of [
    ["error=access_denied&error_code=otp_expired&error_description=private-details", "failed"],
    ["error_code=otp_expired", "failed"],
    ["error=access_denied", "cancelled"],
  ]) {
    const { client, window, calls } = clientHarness({
      href: `https://example.test/?lang=uk&view=game#${fragment}`,
    });
    const result = await client.completeAuthRedirect();
    assert.equal(result.kind, kind);
    assert.equal(window.location.href, "https://example.test/?lang=uk");
    assert.equal(calls.exchanges.length, 0);
    assert.equal(calls.clients, 0);
    assert.deepEqual(Object.keys(result).sort(), ["kind", "passwordReset", "view"]);
  }
});

test("obsolete implicit credentials are removed and cannot establish a session", async () => {
  const { client, calls, window } = clientHarness({ consent: "account",
    href: "https://example.test/?lang=en#access_token=synthetic&refresh_token=synthetic&token_type=bearer&section=help" });
  assert.equal((await client.completeAuthRedirect()).kind, "failed");
  assert.equal(window.location.href, "https://example.test/?lang=en#section=help");
  assert.equal(calls.clients, 0);
  assert.equal(calls.exchanges.length, 0);
});

test("a blocked history rewrite does not prevent the one code exchange", async () => {
  const { client, calls } = clientHarness({ consent: "account", historyFails: true,
    href: "https://example.test/?code=synthetic-code" });
  assert.equal((await client.completeAuthRedirect()).kind, "signed-in");
  assert.equal(calls.exchanges.length, 1);
});

test("provider settings prevent redirects for disabled, malformed and unavailable providers", async () => {
  const { client, calls } = clientHarness({ consent: "account" });
  assert.equal((await client.checkOAuthProvider("google")).ok, true);
  assert.equal((await client.checkOAuthProvider("apple")).errorKey, "accountProviderUnavailable");
  assert.equal(calls.requests[0][0], "https://auth.example.test/auth/v1/settings");
  assert.equal(calls.requests[0][1].credentials, "omit");
  assert.equal(calls.requests[0][1].cache, "no-store");
  assert.ok(calls.requests[0][1].signal instanceof AbortSignal);
  for (const [request, expected] of [
    [async () => Response.json({ external: { google: "true" } }), "accountProviderUnavailable"],
    [async () => new Response("", { status: 429 }), "accountRateLimited"],
    [async () => { throw new TypeError("Network private details"); }, "accountNetworkError"],
  ]) {
    const harness = clientHarness({ consent: "account", request });
    assert.equal((await harness.client.checkOAuthProvider("google")).errorKey, expected);
  }
});

test("auth failures expose only localized allow-listed reasons", () => {
  const cases = [
    [{ code: "invalid_credentials" }, "accountInvalidCredentials"],
    [{ code: "email_not_confirmed" }, "accountEmailUnconfirmed"],
    [{ code: "weak_password" }, "accountWeakPassword"],
    [{ code: "same_password" }, "accountSamePassword"],
    [{ code: "reauthentication_needed" }, "accountReauthenticationRequired"],
    [{ code: "over_email_send_rate_limit" }, "accountRateLimited"],
    [{ code: "email_address_not_authorized" }, "accountEmailDeliveryUnavailable"],
    [{ code: "passkey_disabled" }, "accountPasskeyUnavailable"],
    [{ code: "ERROR_INVALID_RP_ID" }, "accountPasskeyOriginUnavailable"],
    [{ code: "ERROR_CEREMONY_ABORTED" }, "accountPasskeyCancelled"],
    [{ code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", cause: { name: "NotAllowedError" } }, "accountPasskeyCancelled"],
    [{ code: "webauthn_credential_exists" }, "accountPasskeyAlreadyExists"],
    [{ code: "too_many_passkeys" }, "accountPasskeyLimit"],
    [{ name: "AuthRetryableFetchError" }, "accountNetworkError"],
    [{ name: "TimeoutError" }, "accountNetworkError"],
    [{ message: "private provider response", code: "unrecognized" }, "accountAuthError"],
  ];
  for (const [error, key] of cases) {
    assert.deepEqual(authFailure(error), { ok: false, errorKey: key });
    for (const language of ["uk", "de", "en"]) {
      assert.equal(typeof GAME_COPY[language][key], "string");
      assert.ok(GAME_COPY[language][key].length > 0);
    }
  }
  assert.equal(authFailure({ code: "webauthn_challenge_expired" }, "accountPasskeyFailed").errorKey,
    "accountPasskeyFailed");
});

test("email, recovery and both sign-out actions preserve SDK contracts", async () => {
  const { hook, calls } = actionHarness();
  assert.equal((await hook.signUpEmail("test@example.test", "synthetic-password", "Pilot")).needsConfirmation, true);
  assert.equal((await hook.signInEmail("test@example.test", "synthetic-password")).ok, true);
  assert.equal((await hook.resetPassword("test@example.test")).ok, true);
  assert.equal((await hook.updatePassword("new-synthetic-password")).ok, true);
  await hook.signOutLocal();
  await hook.signOutGlobal();
  const signup = calls.find((entry) => entry.name === "signup").args[0];
  assert.equal(signup.options.emailRedirectTo, "https://example.test/?lang=de&view=game");
  assert.equal(signup.options.data.nickname, "Pilot");
  const reset = calls.find((entry) => entry.name === "reset").args[1];
  assert.equal(reset.redirectTo, "https://example.test/?lang=de&view=game&reset=1");
  assert.deepEqual(calls.filter((entry) => entry.name === "signout").map((entry) => entry.args[0].scope),
    ["local", "global"]);
});

test("OAuth requires provider preflight and Apple also requires the operator flag", async () => {
  const disabled = actionHarness({ providerAvailable: false });
  assert.equal((await disabled.hook.signInGoogle()).errorKey, "accountProviderUnavailable");
  assert.equal(disabled.calls.some((entry) => entry.name === "oauth"), false);
  await disabled.hook.signInApple();
  assert.equal(disabled.calls.length, 1, "a hidden Apple provider must not start any action");
  const enabled = actionHarness({ appleEnabled: true });
  assert.equal((await enabled.hook.signInApple()).ok, true);
  assert.deepEqual(enabled.calls.map((entry) => entry.name), ["availability", "oauth"]);
  assert.equal(enabled.calls[1].args[0].provider, "apple");
  assert.equal(enabled.calls[1].args[0].options.redirectTo, "https://example.test/?lang=de&view=game");
});

test("auth action errors retain their safe reason and passkey cancellation stays retryable", async () => {
  const password = actionHarness({ error: { code: "same_password", message: "private" } });
  assert.equal((await password.hook.updatePassword("synthetic")).errorKey, "accountSamePassword");
  const dismissed = actionHarness({ error: { code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
    cause: { name: "NotAllowedError" }, message: "private" } });
  assert.equal((await dismissed.hook.signInWithPasskey()).errorKey, "accountPasskeyCancelled");
  assert.equal(dismissed.stateWrites.some((write) => write.index === 1 && write.value === true), false);
  const unavailable = actionHarness({ error: { code: "passkey_disabled" } });
  assert.equal((await unavailable.hook.signInWithPasskey()).errorKey, "accountPasskeyUnavailable");
  assert.equal(unavailable.stateWrites.some((write) => write.index === 1 && write.value === true), true);
  const signedOut = actionHarness();
  assert.equal((await signedOut.hook.registerPasskey()).ok, false);
  assert.equal((await signedOut.hook.deletePasskey("synthetic-id")).ok, false);
  assert.equal(signedOut.calls.length, 0);
});

test("profile adoption uses the request bearer owner when the rendered session lags a cross-tab switch", async () => {
  const renderedOwner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const requestedOwner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const token = `header.${Buffer.from(JSON.stringify({ sub: requestedOwner })).toString("base64url")}.signature`;
  const panel = panelHarness({ auth: {
    authAvailable: true, consent: "account", hasSession: true,
    sessionUserId: renderedOwner, getAccessToken: async () => token, passkeys: [],
  } });
  panel.render();
  await panel.runEffects();
  assert.equal(panel.calls.length, 1);
  assert.equal(panel.calls[0][1].headers.authorization, `Bearer ${token}`);
  assert.equal(panel.calls[0][1].credentials, "omit");
  assert.equal(panel.adopted.length, 1);
  assert.equal(panel.adopted[0][1], requestedOwner);
  assert.notEqual(panel.adopted[0][1], renderedOwner);
});

test("session retrieval refuses missing or malformed bearer ownership without adopting an orphan", async () => {
  for (const token of [null, "malformed", "header.e30.signature"]) {
    const panel = panelHarness({ auth: {
      authAvailable: true, consent: "account", hasSession: true,
      sessionUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      getAccessToken: async () => token, passkeys: [],
    } });
    panel.render();
    await panel.runEffects();
    assert.equal(panel.calls.length, 0);
    assert.equal(panel.adopted.length, 0);
    const nodes = elements(panel.render());
    assert.ok(nodes.some((node) => node.props.role === "alert" &&
      node.props.children === GAME_COPY.en.accountSessionExpired));
    assert.ok(nodes.some((node) => node.type === "button" &&
      node.props.children === GAME_COPY.en.syncRetry));
  }
});

test("successful passkey mutations surface refresh failure, clear stale keys and recover with list-only retry", async () => {
  const session = { user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } };
  const original = { id: "old-key", friendly_name: "Original key", created_at: "2026-09-28T10:00:00Z" };
  const replacement = { ...original, id: "current-key", friendly_name: "Current key" };
  for (const action of ["registerPasskey", "deletePasskey"]) {
    for (const throws of [false, true]) {
      let listCalls = 0;
      const harness = actionHarness({ session, responses: { "passkey-list": async () => {
        listCalls += 1;
        if (listCalls === 2) {
          if (throws) throw new TypeError("Simulated failed refresh");
          return { data: null, error: { code: "request_timeout" } };
        }
        return { data: [listCalls === 1 ? original : replacement], error: null };
      } } });
      assert.equal((await harness.hook.listPasskeys()).ok, true);
      assert.equal(harness.render().passkeys[0].id, original.id);
      const result = await harness.render()[action](original.id);
      assert.equal(result.ok, false);
      assert.equal(result.errorKey, "accountPasskeyRefreshFailed");
      assert.equal(harness.render().passkeys.length, 0, "stale/deleted keys must not remain actionable");
      assert.equal(harness.render().passkeysRefreshFailed, true);
      assert.equal((await harness.render().listPasskeys()).ok, true);
      assert.equal(harness.render().passkeysRefreshFailed, false);
      assert.equal(harness.render().passkeys[0].id, replacement.id);
      assert.equal(harness.calls.filter((call) => call.name === "passkey-register" ||
        call.name === "passkey-delete").length, 1, "refreshing must not repeat the completed mutation");
    }
  }
  for (const language of ["uk", "de", "en"]) {
    assert.ok(GAME_COPY[language].accountPasskeyRefreshFailed.length > 0);
    assert.ok(GAME_COPY[language].accountPasskeyRefreshAction.length > 0);
  }
});

test("failed passkey mutations preserve their reason and do not fetch a success list", async () => {
  const harness = actionHarness({ session: { user: { id: "synthetic-account" } },
    error: { code: "webauthn_credential_exists" } });
  assert.equal((await harness.hook.registerPasskey()).errorKey, "accountPasskeyAlreadyExists");
  assert.equal(harness.calls.some((call) => call.name === "passkey-list"), false);
});

test("the passkey refresh UI retries only the list and does not claim a failed list is empty", async () => {
  let lists = 0;
  let mutations = 0;
  const auth = {
    authAvailable: true, consent: "account", hasSession: true,
    sessionUserId: "synthetic-account", passkeys: [], passkeysRefreshFailed: true,
    listPasskeys: async () => { lists += 1; auth.passkeysRefreshFailed = false; return { ok: true }; },
    registerPasskey: async () => { mutations += 1; return { ok: true }; },
    deletePasskey: async () => { mutations += 1; return { ok: true }; },
  };
  const panel = panelHarness({ auth });
  const nodes = elements(panel.render());
  assert.equal(nodes.some((node) => node.props.children === GAME_COPY.en.accountPasskeyEmpty), false);
  const retry = nodes.find((node) => node.type === "button" &&
    node.props.children === GAME_COPY.en.accountPasskeyRefreshAction);
  assert.ok(retry);
  retry.props.onClick();
  await panel.flush();
  assert.equal(lists, 1);
  assert.equal(mutations, 0);
  assert.equal(elements(panel.render()).some((node) =>
    node.props.children === GAME_COPY.en.accountPasskeyRefreshAction), false);
});

test("out-of-order account session responses cannot reactivate an earlier profile or clear the newer request", async () => {
  const firstOwner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const nextOwner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const first = deferred();
  const second = deferred();
  const auth = { authAvailable: true, consent: "account", hasSession: true,
    sessionUserId: firstOwner, passkeys: [],
    getAccessToken: async () => fixtureToken(auth.sessionUserId) };
  let requests = 0;
  const panel = panelHarness({ auth, request: () => ++requests === 1 ? first.promise : second.promise });
  panel.render();
  await panel.runEffects();
  auth.sessionUserId = nextOwner;
  panel.render();
  await panel.runEffects();
  first.resolve(Response.json({ profile: { nickname: "Earlier" } }));
  await panel.flush();
  assert.equal(panel.adopted.length, 0);
  assert.equal(elements(panel.render()).find((node) => node.type === "button" &&
    node.props.children === GAME_COPY.en.accountSignOut).props.disabled, true);
  second.resolve(Response.json({ profile: { nickname: "Current" } }));
  await panel.flush();
  assert.equal(panel.adopted.length, 1);
  assert.equal(panel.adopted[0][1], nextOwner);
  assert.equal(elements(panel.render()).find((node) => node.type === "button" &&
    node.props.children === GAME_COPY.en.accountSignOut).props.disabled, false);
});

test("a pending session response is ignored after sign-out or panel unmount", async () => {
  for (const departure of ["signout", "unmount"]) {
    const response = deferred();
    const auth = { authAvailable: true, consent: "account", hasSession: true,
      sessionUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", passkeys: [],
      getAccessToken: async () => fixtureToken(auth.sessionUserId) };
    const panel = panelHarness({ auth, request: () => response.promise });
    panel.render();
    await panel.runEffects();
    if (departure === "unmount") panel.unmount();
    else {
      auth.hasSession = false;
      auth.sessionUserId = null;
      panel.render();
      await panel.runEffects();
    }
    response.resolve(Response.json({ profile: {} }));
    await panel.flush();
    assert.equal(panel.adopted.length, 0);
  }
});

test("a stale initial session read cannot undo a newer auth event", async () => {
  const oldSession = { user: { id: "earlier-account" } };
  const newSession = { user: { id: "current-account" } };
  const snapshot = deferred();
  const harness = actionHarness({ session: oldSession,
    responses: { session: () => snapshot.promise } });
  harness.runEffects();
  await new Promise((resolve) => setImmediate(resolve));
  harness.changeSession(newSession);
  snapshot.resolve({ data: { session: oldSession }, error: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.render().sessionUserId, newSession.user.id);
});

test("passkey refresh ignores older reads and preserves the newest list", async () => {
  const first = deferred();
  let listCalls = 0;
  const harness = actionHarness({ session: { user: { id: "current-account" } },
    responses: { "passkey-list": () => ++listCalls === 1 ? first.promise :
      { data: [{ id: "current-key", created_at: "2026-09-29" }], error: null } } });
  const older = harness.hook.listPasskeys();
  await new Promise((resolve) => setImmediate(resolve));
  await harness.hook.listPasskeys();
  first.resolve({ data: [{ id: "stale-key", created_at: "2026-09-28" }], error: null });
  await older;
  assert.equal(harness.render().passkeys[0].id, "current-key");
  assert.equal(harness.render().passkeysLoading, false);
});

test("passkey lists never attach another SDK session's credentials to a stale rendered account", async () => {
  for (const changeDuringList of [false, true]) {
    const before = { user: { id: "earlier-account" } };
    const after = { user: { id: "current-account" } };
    let sessionReads = 0;
    const harness = actionHarness({ session: before, responses: {
      session: () => ({ data: { session: changeDuringList && ++sessionReads === 1 ? before : after }, error: null }),
      "passkey-list": { data: [{ id: "other-account-key", created_at: "2026-09-29" }], error: null },
    } });
    assert.equal((await harness.hook.listPasskeys()).errorKey, "accountSessionExpired");
    assert.equal(harness.render().passkeys.length, 0);
    assert.equal(harness.render().passkeysRefreshFailed, true);
    assert.equal(harness.calls.filter((call) => call.name === "passkey-list").length, changeDuringList ? 1 : 0);
  }
});

test("an old account's pending passkey failure cannot erase the new account's successful list", async () => {
  const oldSession = { user: { id: "earlier-account" } };
  const newSession = { user: { id: "current-account" } };
  const pending = deferred();
  let listCalls = 0;
  const harness = actionHarness({ session: oldSession, responses: {
    "passkey-list": () => ++listCalls === 1 ? pending.promise :
      { data: [{ id: "current-key", created_at: "2026-09-29" }], error: null },
  } });
  harness.runEffects();
  await new Promise((resolve) => setImmediate(resolve));
  const earlier = harness.hook.listPasskeys();
  await new Promise((resolve) => setImmediate(resolve));
  harness.changeSession(newSession);
  await harness.render().listPasskeys();
  pending.reject(new TypeError("Earlier request failed"));
  await earlier;
  assert.equal(harness.render().passkeys[0].id, "current-key");
  assert.equal(harness.render().passkeysRefreshFailed, false);
});

test("a completed old-account mutation cannot cancel the new account's pending passkey refresh", async () => {
  for (const operation of ["register", "delete"]) {
    const oldSession = { user: { id: "earlier-account" } };
    const newSession = { user: { id: "current-account" } };
    const mutation = deferred();
    const refresh = deferred();
    const harness = actionHarness({ session: oldSession, responses: {
      [`passkey-${operation}`]: () => mutation.promise,
      "passkey-list": () => refresh.promise,
    } });
    harness.runEffects();
    await new Promise((resolve) => setImmediate(resolve));
    const earlier = operation === "register" ? harness.hook.registerPasskey() :
      harness.hook.deletePasskey("earlier-key");
    harness.changeSession(newSession);
    const current = harness.render().listPasskeys();
    await new Promise((resolve) => setImmediate(resolve));
    mutation.resolve({ error: null });
    await earlier;
    assert.equal(harness.render().passkeysLoading, true);
    refresh.resolve({ data: [{ id: "current-key", created_at: "2026-09-29" }], error: null });
    await current;
    assert.equal(harness.render().passkeys[0].id, "current-key");
    assert.equal(harness.render().passkeysLoading, false);
  }
});

test("the passkey section can fetch again after a direct cross-tab account change", async () => {
  let lists = 0;
  const auth = { authAvailable: true, consent: "account", hasSession: true,
    sessionUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", passkeys: [],
    getAccessToken: async () => fixtureToken(auth.sessionUserId),
    listPasskeys: async () => { lists += 1; return { ok: true }; } };
  const panel = panelHarness({ auth });
  let tree = panel.render();
  await panel.runEffects();
  let details = elements(tree).find((node) => node.type === "details");
  details.props.onToggle({ currentTarget: { open: true } });
  details.props.onToggle({ currentTarget: { open: true } });
  await panel.flush();
  assert.equal(lists, 1);
  auth.sessionUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  tree = panel.render();
  await panel.runEffects();
  details = elements(tree).find((node) => node.type === "details");
  details.props.onToggle({ currentTarget: { open: true } });
  await panel.flush();
  assert.equal(lists, 2);
});

test("an earlier account's list retry cannot mark the new passkey section as already fetched", async () => {
  const pending = deferred();
  let lists = 0;
  const auth = { authAvailable: true, consent: "account", hasSession: true,
    sessionUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", passkeys: [],
    passkeysRefreshFailed: true,
    getAccessToken: async () => fixtureToken(auth.sessionUserId),
    listPasskeys: () => ++lists === 1 ? pending.promise : Promise.resolve({ ok: true }) };
  const panel = panelHarness({ auth });
  panel.render();
  await panel.runEffects();
  const retry = elements(panel.render()).find((node) => node.type === "button" &&
    node.props.children === GAME_COPY.en.accountPasskeyRefreshAction);
  retry.props.onClick();
  auth.sessionUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  auth.passkeysRefreshFailed = false;
  panel.render();
  await panel.runEffects();
  pending.resolve({ ok: true });
  await panel.flush();
  const details = elements(panel.render()).find((node) => node.type === "details");
  details.props.onToggle({ currentTarget: { open: true } });
  await panel.flush();
  assert.equal(lists, 2);
});
