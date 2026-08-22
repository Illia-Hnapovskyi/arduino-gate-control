import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GAME_COPY,
  PAGE_COPY,
  SPACE_DEFENDER_COPY,
} from "../app/i18n.ts";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("production build contains the app shell and referenced assets", async () => {
  const html = await readFile(path.join(projectRoot, "dist/index.html"), "utf8");
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /Arduino Gate \+ Radar \+ Joystick Game/);

  const assetPaths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)]
    .map((match) => match[1]);
  assert.ok(assetPaths.length >= 2, "expected built JavaScript and CSS assets");

  await Promise.all(
    assetPaths.map((assetPath) =>
      access(path.join(projectRoot, "dist", assetPath.slice(1))),
    ),
  );
});

test("production build includes the downloadable firmware and instructions", async () => {
  const firmware = await readFile(
    path.join(projectRoot, "dist/arduino-smart-gate.ino"),
    "utf8",
  );
  const instructions = await readFile(
    path.join(projectRoot, "dist/README-UK.md"),
    "utf8",
  );

  assert.match(firmware, /ACTIVE_BUZZER_PIN = 5/);
  assert.match(firmware, /Serial\.begin\(115200\)/);
  assert.match(instructions, /Active Buzzer/);
  assert.match(instructions, /D5/);
});

test("all languages expose the same page and game translation keys", () => {
  for (const translations of [PAGE_COPY, GAME_COPY, SPACE_DEFENDER_COPY]) {
    const expectedKeys = Object.keys(translations.uk).sort();
    assert.deepEqual(Object.keys(translations.de).sort(), expectedKeys);
    assert.deepEqual(Object.keys(translations.en).sort(), expectedKeys);
  }
});

function translationShape(value) {
  if (Array.isArray(value)) return value.map(translationShape);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, translationShape(value[key])]),
    );
  }
  return typeof value;
}

test("nested Space Defender localization stays in full uk/de/en parity", () => {
  assert.deepEqual(
    translationShape(SPACE_DEFENDER_COPY.de),
    translationShape(SPACE_DEFENDER_COPY.uk),
  );
  assert.deepEqual(
    translationShape(SPACE_DEFENDER_COPY.en),
    translationShape(SPACE_DEFENDER_COPY.uk),
  );
});

test("Space Defender formatters use the selected locale and remapped controls", () => {
  assert.equal(SPACE_DEFENDER_COPY.en.formatNumber(12_345), "12,345");
  assert.equal(SPACE_DEFENDER_COPY.de.formatNumber(12_345), "12.345");
  assert.equal(SPACE_DEFENDER_COPY.en.formatDuration(125), "2:05");
  assert.match(SPACE_DEFENDER_COPY.uk.formatCooldown(2), /2/);
  assert.match(
    SPACE_DEFENDER_COPY.en.formatDate("2026-07-31T00:00:00.000Z"),
    /2026/,
  );
  assert.match(
    SPACE_DEFENDER_COPY.en.formatControls("I", "K", "J", "L", "F", "G"),
    /I\/K\/J\/L.*F.*G/,
  );
});

test("the profile UI is account-only and never touches an access code", async () => {
  const [statsPanel, accountPanel, page, css] = await Promise.all([
    readFile(path.join(projectRoot, "app/PlayerStatsPanel.tsx"), "utf8"),
    readFile(path.join(projectRoot, "app/AccountPanel.tsx"), "utf8"),
    readFile(path.join(projectRoot, "app/page.tsx"), "utf8"),
    readFile(path.join(projectRoot, "app/globals.css"), "utf8"),
  ]);

  // No component may read, render, validate or send an access code any more.
  for (const source of [statsPanel, accountPanel, page]) {
    assert.doesNotMatch(source, /accessCode|AccessCode/);
    assert.doesNotMatch(source, /connectProfile|linkActiveProfile/);
  }
  assert.doesNotMatch(css, /\.profile-code-box|\.profile-connect-form/);

  // A profile now requires a session: without one the panel only explains that,
  // and the nickname prompt is reachable for a signed-in player alone.
  assert.match(statsPanel, /!profile && !auth\.hasSession &&/);
  assert.match(
    statsPanel,
    /auth\.hasSession && \(profile === null \|\| profile\.orphaned\)/,
  );
  assert.match(statsPanel, /copy\.accountRequiredTitle/);
  assert.match(statsPanel, /stats\.createAccountProfile\(validated\.value\)/);
  assert.match(statsPanel, /stats\.hasOrphanedProfiles &&/);
  assert.match(statsPanel, /copy\.accountCodeRetiredNotice/);

  // The Google provider is not configured yet, so its failure must read as
  // "unavailable" instead of surfacing the provider's own error.
  assert.match(accountPanel, /copy\.accountProviderUnavailable/);

  // Sessions and the consent choice stay in localStorage; nothing sets cookies.
  for (const source of [statsPanel, accountPanel, page]) {
    assert.doesNotMatch(source, /document\.cookie/);
  }
  assert.match(accountPanel, /credentials: "omit"/);
});

async function browserSources() {
  const appDir = path.join(projectRoot, "app");
  const relativePaths = (await readdir(appDir, { recursive: true })).filter(
    (entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"),
  );
  return Promise.all(
    relativePaths.map(async (relativePath) => [
      relativePath.split(path.sep).join("/"),
      await readFile(path.join(appDir, relativePath), "utf8"),
    ]),
  );
}

test("exactly one module completes the provider redirect", async () => {
  const sources = await browserSources();
  const exchangers = sources.filter(([, source]) =>
    source.includes("exchangeCodeForSession"),
  );

  // Two handlers raced each other: both stripped the URL, so whichever ran
  // second found no code left to exchange. The redirect is finished in one
  // place, and every other module reads the result it returns.
  assert.deepEqual(
    exchangers.map(([file]) => file),
    ["auth/client.ts"],
  );
  const [, client] = exchangers[0];
  assert.equal(
    [...client.matchAll(/exchangeCodeForSession\(/g)].length,
    1,
    "the exchange has exactly one call site",
  );
  // A code left in the address bar survives in history and stays redeemable
  // until it is spent, so it is removed before the first await.
  assertOrdered(
    client,
    "replaceState",
    "exchangeCodeForSession(",
    "the callback URL is stripped before the code is exchanged",
  );

  const page = sources.find(([file]) => file === "page.tsx")[1];
  assert.equal(
    [...page.matchAll(/completeAuthRedirect\(/g)].length,
    1,
    "the page awaits the shared redirect result exactly once",
  );
  assert.doesNotMatch(page, /authCallbackHandled/);
  assert.doesNotMatch(page, /replaceState/);
});

test("the redirect result opens the reset dialog and changes the tab safely", async () => {
  const page = await readFile(path.join(projectRoot, "app/page.tsx"), "utf8");

  // A password can only be replaced through a redirect that established a
  // session; a cancelled or failed one must not open the dialog.
  assert.match(
    page,
    /redirect\.passwordReset && redirect\.kind === "signed-in"/,
  );

  // Landing on the game tab must take the same route as clicking it: that path
  // refuses to leave the game while data is at risk, and stops auto and radar
  // mode when entering. Writing the tab state directly would skip both.
  assert.match(page, /redirect\.view === "game"[\s\S]{0,80}selectTabRef\.current/);
  assert.equal(
    [...page.matchAll(/setActiveTab\(/g)].length,
    1,
    "selectTab stays the only writer of the tab state",
  );
  assert.match(
    page,
    /nextTab === "control" && activeTab === "game" && gameDataAtRisk/,
  );
  assert.match(page, /nextTab === "game"[\s\S]{0,200}sendCommand\("RADAR:0"\)/);
});

// Both halves must be present, not merely in order: a missing needle answers
// indexOf with -1, which sorts before every real position and would let a
// removed line pass an ordering assertion.
function assertOrdered(source, first, second, message) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.ok(firstIndex > -1, `${message} (missing: ${first})`);
  assert.ok(secondIndex > -1, `${message} (missing: ${second})`);
  assert.ok(firstIndex < secondIndex, message);
}

test("a settled redirect opens the profile section once per page load", async () => {
  const panel = await readFile(
    path.join(projectRoot, "app/GamePanel.tsx"),
    "utf8",
  );

  // The account panel renders the redirect notice and is also the only way back
  // to the profile, and it lives in exactly one menu section. Asking for that
  // section only for the two failure kinds left a player who really did sign in
  // on "play", with the profile one more click away — the detour the redirect
  // exists to remove. Every redirect that happened lands there; a page load
  // without one (`none`) must still open on the menu's own default.
  const claim = panel.match(/function claimRedirectSection\([\s\S]*?\n\}/);
  assert.ok(claim, "the requested section must be resolved in one place");
  assert.match(claim[0], /kind === "none" \? null : "profile"/);
  assert.doesNotMatch(
    panel,
    /kind === "failed" \|\| redirect\.kind === "cancelled"/,
    "the requested section must not single out the two failure kinds",
  );

  // One claim per page load, like the notice it reveals. GamePanel unmounts with
  // the game tab, so a component-local guard let the memoised redirect re-open
  // the section after the player had dismissed that notice. The claim is spent
  // for every kind, which is what keeps the successful case's landing working.
  assert.match(panel, /^let redirectSectionClaimed = false;$/m);
  assertOrdered(
    claim[0],
    "if (redirectSectionClaimed) return null;",
    "redirectSectionClaimed = true;",
    "a second claim must be refused before the flag is spent again",
  );
  assertOrdered(
    claim[0],
    "redirectSectionClaimed = true;",
    '"profile"',
    "the claim is spent whatever the kind, not only when a section is returned",
  );
  // Two writers now, and the second one is the point: the menu is unmounted for
  // the length of a run, so a request still held when it remounts would re-open
  // the section after every single game. One writer sets it from the claim, one
  // clears it the moment the menu says it has taken it, and nothing else may
  // touch it.
  assert.equal(
    [...panel.matchAll(/setRedirectSection\(/g)].length,
    2,
    "only the claim sets the requested section and only the hand-over clears it",
  );
  assert.match(panel, /const section = claimRedirectSection\(redirect\.kind\);/);
  assert.match(
    panel,
    /const forgetRedirectSection = useCallback\(\(\) => \{\s*setRedirectSection\(null\);/,
  );
  // Spent on the two paths that actually begin a run. It has to be an event
  // handler: the menu resolves the request during render rather than copying it
  // into state, and the lint rule forbids clearing it from an effect.
  assert.equal(
    [...panel.matchAll(/forgetRedirectSection\(\);/g)].length,
    2,
    "starting and continuing a run each spend the section request",
  );

  // StrictMode tears the first mount down before the memoised promise settles,
  // so claiming before that check would spend the request on a dead effect.
  const effect = panel.match(
    /void completeAuthRedirect\(\)\.then\(\(redirect\) => \{[\s\S]*?\n    \}\);/,
  );
  assert.ok(effect, "the panel must still await the memoised redirect");
  assertOrdered(
    effect[0],
    "if (!active) return;",
    "claimRedirectSection(",
    "the claim must happen after the mount check",
  );
});

test("the reset dialog and the panel share one password minimum", async () => {
  const page = await readFile(path.join(projectRoot, "app/page.tsx"), "utf8");

  // Two dialogs ask for a password with the same error copy, and the real
  // authority is the project's own minimum. A bare literal in one of them is how
  // they start disagreeing, so both read the constant AccountPanel exports.
  assert.match(page, /password\.length < MIN_PASSWORD_LENGTH/);
  assert.match(page, /minLength=\{MIN_PASSWORD_LENGTH\}/);
  assert.doesNotMatch(page, /password\.length < \d/);
  assert.doesNotMatch(page, /minLength=\{\d/);
});

test("?lang beats the stored language and is then persisted", async () => {
  const page = await readFile(path.join(projectRoot, "app/page.tsx"), "utf8");

  // Precedence is URL > stored > "uk". The URL is applied at module load,
  // before the component reads the store, which is what makes it win.
  const applyIndex = page.indexOf("\napplyLanguageFromUrl();");
  const componentIndex = page.indexOf("export default function Home");
  assert.ok(
    applyIndex > 0 && applyIndex < componentIndex,
    "the URL language is applied before the first snapshot is read",
  );

  const applyBody = page.match(
    /function applyLanguageFromUrl\(\) \{([\s\S]*?)\n\}/,
  );
  assert.ok(applyBody, "applyLanguageFromUrl must stay a module-level function");
  assert.match(applyBody[1], /window\.location\.search/);
  // Only a language the site actually ships is accepted; anything else falls
  // through to the stored value instead of throwing or blanking the copy.
  assert.match(applyBody[1], /LANGUAGE_OPTIONS/);
  // Persisted through the existing store, so later visits stay in that
  // language and the switcher keeps working unchanged.
  assert.match(applyBody[1], /saveLanguage\(/);

  const readBody = page.match(/function readLanguage\(\)[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(readBody, "readLanguage must stay the snapshot source");
  assert.match(readBody[1], /: "uk";$/m);
  assert.match(
    page,
    /useSyncExternalStore<Language>\(\s*subscribeToLanguage,\s*readLanguage,/,
  );

  // Applying it at module load means the write runs before src/main.tsx renders
  // anything, so a store at quota — or a private mode that allows reads and
  // refuses writes — would abort the import and paint a blank page, and only for
  // the shared `?lang=` link this whole feature exists for. A refused write may
  // cost persistence and nothing else, exactly as saveConsentChoice treats its
  // own; the event still fires, so nothing else in the page load changes.
  const saveBody = page.match(/function saveLanguage\([\s\S]*?\n\}/);
  assert.ok(saveBody, "saveLanguage must stay a module-level function");
  assert.match(saveBody[0], /try \{\s*window\.localStorage\.setItem\(/);
  assertOrdered(
    saveBody[0],
    "} catch {",
    "window.dispatchEvent(",
    "the failed write must not skip the language-change event",
  );
});

test("?lang survives a store that refuses writes or throws on reads", async () => {
  const page = await readFile(path.join(projectRoot, "app/page.tsx"), "utf8");

  // Routing `?lang=` through localStorage alone did not merely cost persistence
  // in a browser that allows reads and refuses writes, it lost the feature: the
  // swallowed write, the change event that still fires, and a re-read of the OLD
  // stored value paint Ukrainian for the German reader the parameter exists for —
  // a shared link opened in a private window, which is the whole use case. The
  // language the page was asked to show is therefore kept in memory as well, and
  // read before the store.
  assert.match(page, /^let languageOverride: Language \| null = null;$/m);

  const readBody = page.match(/function readLanguage\(\)[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(readBody, "readLanguage must stay the snapshot source");
  assertOrdered(
    readBody[1],
    "if (languageOverride) return languageOverride;",
    "window.localStorage.getItem(",
    "the requested language must win over the stored one",
  );

  // readLanguage is the snapshot function, so a document where reading storage
  // throws rather than refusing writes would take the render down: a blank page
  // instead of a wrong language. saveLanguage was already guarded; this is the
  // other half.
  assert.match(readBody[1], /try \{\s*const savedLanguage = window\.localStorage/);
  assert.match(readBody[1], /\} catch \{[\s\S]*return "uk";/);

  const saveBody = page.match(/function saveLanguage\([\s\S]*?\n\}/);
  assert.ok(saveBody, "saveLanguage must stay a module-level function");
  assertOrdered(
    saveBody[0],
    "languageOverride = language;",
    "try {",
    "the requested language is recorded whether or not the write succeeds",
  );

  // Cross-tab updates still win over it: another tab's write is a newer choice
  // than whatever this document was asked to show on load.
  const subscribeBody = page.match(
    /function subscribeToLanguage\([\s\S]*?\n\}/,
  );
  assert.ok(subscribeBody, "subscribeToLanguage must stay the subscription");
  assert.match(subscribeBody[0], /languageOverride = null;\n\s*callback\(\);/);
});

test("the setup docs agree with AGENTS.md on what is live in Supabase", async () => {
  const [readme, setup] = await Promise.all([
    readFile(path.join(projectRoot, "README.md"), "utf8"),
    readFile(path.join(projectRoot, "SUPABASE_SETUP.md"), "utf8"),
  ]);

  // AGENTS.md states which providers are enabled in the live project and then
  // sends the reader to SUPABASE_SETUP.md for the Dashboard checklist. Correcting
  // the live state in one file and leaving the other asserting the opposite makes
  // the next maintainer arbitrate between two in-repo documents, and invites
  // re-doing Dashboard work that is already done.
  for (const [name, doc] of [
    ["README.md", readme],
    ["SUPABASE_SETUP.md", setup],
  ]) {
    assert.doesNotMatch(
      doc,
      /(НЕ|\*\*не\*\*) налаштований/,
      `${name} still says a provider is not configured`,
    );
    assert.match(
      doc,
      /2026-08-22/,
      `${name} must date the live Supabase Auth state`,
    );
  }
});

test("a session never inherits a profile that belongs to another account", async () => {
  const [accountPanel, gamePanel] = await Promise.all([
    readFile(path.join(projectRoot, "app/AccountPanel.tsx"), "utf8"),
    readFile(path.join(projectRoot, "app/GamePanel.tsx"), "utf8"),
  ]);

  // The server resolved this profile from the account link for this very
  // token, so the verified owner must be recorded. Dropping it leaves every
  // profile the code-era build stored (code, publicId, no owner) looking
  // orphaned to its own account: it can never sync, and the panel would offer
  // the destructive force-forget beside a "your code no longer works" notice.
  assert.match(
    accountPanel,
    /stats\.adoptSessionProfile\(session\.body, auth\.sessionUserId\)/,
  );

  // The hook can only tell this account's vault entry from one another account
  // left behind on a shared browser if it knows who is signed in.
  assert.match(gamePanel, /const \{ sessionUserId \} = useAuthSession\(\);/);
  assert.match(
    gamePanel,
    /useGameStats\(\{[^}]*\bsessionUserId,[^}]*\}\)/,
    "GamePanel must pass the signed-in account into useGameStats",
  );
});

test("the passkey UI degrades gracefully and never lists on mount", async () => {
  const accountPanel = await readFile(
    path.join(projectRoot, "app/AccountPanel.tsx"),
    "utf8",
  );

  assert.match(
    accountPanel,
    /auth\.passkeySupported && !auth\.passkeyUnavailable/,
  );
  assert.match(accountPanel, /copy\.accountPasskeySignInAction/);
  assert.match(accountPanel, /copy\.accountPasskeyUnavailable/);
  assert.match(accountPanel, /copy\.accountPasskeyAddAction/);
  assert.match(accountPanel, /copy\.accountPasskeyEmpty/);
  assert.match(accountPanel, /copy\.accountPasskeyRecoveryHint/);
  assert.match(
    accountPanel,
    /window\.confirm\(copy\.accountPasskeyDeleteConfirm\)/,
  );

  // The list is one network call behind a disclosure: it must be requested when
  // the section is first opened, never while the panel mounts.
  assert.equal(
    [...accountPanel.matchAll(/auth\.listPasskeys\(\)/g)].length,
    1,
    "the passkey list has exactly one call site",
  );
  assert.match(
    accountPanel,
    /passkeysRequestedRef\.current = true;\s*void auth\.listPasskeys\(\)/,
  );
});

test("Space Defender overlays and compact HUD keep their accessibility contract", async () => {
  const [panel, menu, hud, overlays, progression, css] = await Promise.all([
    readFile(path.join(projectRoot, "app/GamePanel.tsx"), "utf8"),
    readFile(path.join(projectRoot, "app/game/GameMenu.tsx"), "utf8"),
    readFile(path.join(projectRoot, "app/game/GameHud.tsx"), "utf8"),
    readFile(path.join(projectRoot, "app/game/GameOverlays.tsx"), "utf8"),
    readFile(path.join(projectRoot, "app/game/ProgressPanels.tsx"), "utf8"),
    readFile(path.join(projectRoot, "app/globals.css"), "utf8"),
  ]);

  assert.ok(
    [...overlays.matchAll(/aria-labelledby=/g)].length >= 3,
    "every pause, upgrade, and result dialog needs an accessible title",
  );
  assert.ok(
    [...overlays.matchAll(/aria-describedby=/g)].length >= 3,
    "every game dialog needs an accessible description",
  );
  assert.match(overlays, /previousFocusRef/);
  assert.match(overlays, /event\.key !== "Tab"/);
  assert.match(menu, /menuTitleRef\.current\?\.focus\(\)/);
  assert.match(overlays, /result\.saved \?/);
  assert.match(overlays, /copy\.retrySave/);
  assert.match(panel, /if \(result && !result\.saved\) return;/);
  assert.match(panel, /window\.confirm\(copy\.discardRecoveryConfirm\)/);
  // Checkpoints are stored per profile owner, so the clear call carries the owner
  // id. The invariant being pinned is unchanged: a failed cleanup must block a new
  // launch instead of silently restoring a stale run.
  assert.match(panel, /!clearRunSnapshot\(storage, ownerId\)/);
  assert.match(progression, /aria-valuenow=\{progress\}/);
  assert.match(hud, /copy\.hud\.shield/);
  assert.match(
    menu,
    /disabled=\{hasResume \|\| hasUnsavedResult \|\| !connected \|\| !hasProfile\}/,
  );
  assert.match(css, /data-reduced-motion="true"/);
  assert.match(css, /\.space-canvas-wrap:has\(\.space-game-overlay\)/);
  assert.doesNotMatch(css, /margin-left:\s*-22px/);
  assert.doesNotMatch(
    css,
    /@media \(max-width: 980px\)[\s\S]*?\.space-energy-cluster\s*\{\s*display:\s*none;/,
  );
});

// The class names a browser actually receives: the LITERAL text of every
// `className` attribute, with `${...}` interpolations replaced by a space
// because their runtime value is unknowable here. Identifiers inside a
// className expression are skipped on purpose — a reference set built from the
// whole file would let a TypeScript name such as `joystickX` or a translated
// sentence mentioning the joystick vouch for a selector nothing renders.
function renderedClassNames(source) {
  const attribute = /className=(?:"([^"]*)"|'([^']*)'|\{)/g;
  const literals = [];
  for (
    let match = attribute.exec(source);
    match;
    match = attribute.exec(source)
  ) {
    if (match[1] !== undefined || match[2] !== undefined) {
      literals.push(match[1] ?? match[2]);
      continue;
    }
    // Brace form: walk to the matching brace so a multi-line template literal
    // or a nested ternary is captured whole, then keep only its quoted and
    // template segments.
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < source.length && depth > 0) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
      index += 1;
    }
    const expression = source.slice(match.index + match[0].length, index - 1);
    for (const segment of expression.matchAll(
      /"([^"]*)"|'([^']*)'|`([^`]*)`/g,
    )) {
      literals.push(segment[1] ?? segment[2] ?? segment[3]);
    }
    attribute.lastIndex = index;
  }
  return literals.join(" ").replace(/\$\{[\s\S]*?\}/g, " ");
}

test("the live joystick card is rendered and its CSS carries no ballast", async () => {
  const [panel, css] = await Promise.all([
    readFile(path.join(projectRoot, "app/GamePanel.tsx"), "utf8"),
    readFile(path.join(projectRoot, "app/globals.css"), "utf8"),
  ]);

  // The diagnostic card itself: heading, draggable stick, three readings, hint.
  assert.match(panel, /className="joystick-card space-joystick-aside"/);
  assert.match(panel, /legacyCopy\.liveSignal/);
  assert.match(panel, /legacyCopy\.yourJoystick/);
  assert.match(panel, /joystick-link \$\{connection\}/);
  assert.match(panel, /legacyCopy\.signalReceived : legacyCopy\.noConnection/);
  assert.match(panel, /VRx · A0/);
  assert.match(panel, /VRy · A1/);
  assert.match(panel, /SW · D4/);
  assert.match(panel, /legacyCopy\.touchJoystickHint/);
  // The readings map a live drag back onto the board's 0-1023 analog range and
  // otherwise echo the raw telemetry.
  assert.match(panel, /Math\.round\(512 \+ virtualJoystick\.x \* 511\)/);
  assert.match(panel, /Math\.round\(512 \+ virtualJoystick\.y \* 511\)/);
  // The knob shares the run loop's transfer function, dead zone and saturation
  // point included. A private axis mapping made the diagnostic lie: it showed
  // deflection inside the dead zone the ship ignores, and pinned itself at full
  // travel while the ship was still accelerating.
  assert.match(
    panel,
    /import \{[^}]*normalizeJoystickAxis[^}]*\} from "\.\/game\/input";/,
  );
  assert.match(panel, /normalizeJoystickAxis\(joystickX, joystickCentre\.x\)/);
  assert.match(panel, /normalizeJoystickAxis\(joystickY, joystickCentre\.y\)/);
  assert.doesNotMatch(panel, /joystickX - joystickCentre\.x/);
  assert.doesNotMatch(panel, /joystickY - joystickCentre\.y/);
  // The card reuses the in-run handlers instead of growing its own, and keeps
  // the group/label pattern the touch deck uses.
  assert.match(panel, /aria-label=\{legacyCopy\.touchJoystickAria\}/);
  assert.ok(
    [...panel.matchAll(/onPointerDown=\{startVirtualJoystick\}/g)].length === 2,
    "the menu card and the in-run deck share one set of drag handlers",
  );
  // Still exactly two calibrate buttons: the calibration aside and the toolbar.
  assert.ok(
    [...panel.matchAll(/onClick=\{calibrateJoystick\}/g)].length === 2,
    "the card must not add a third calibrate button",
  );
  // The cream card lives one ancestor away from the near-white --space-ink.
  assert.match(css, /\.joystick-card \{[^}]*color: var\(--ink\);/);

  // Ballast guard: every joystick rule in the stylesheet must still be
  // RENDERED by a browser source — matched against className literals alone,
  // never the whole file — so a class whose markup is deleted cannot leave its
  // CSS behind unnoticed. Comments are stripped from BOTH sides — a
  // comment that names a class, in the stylesheet or in a source file, must not
  // vouch for it — and the two sides are compared as whole class tokens, so
  // renaming `joystick-visual` to `joystick-visual-pad` in the markup orphans
  // the old rule loudly instead of passing on the shared prefix.
  const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  const selectors = stripComments(css);
  const joystickClasses = [
    ...new Set(
      [...selectors.matchAll(/\.([A-Za-z0-9_-]*joystick[A-Za-z0-9_-]*)/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
  assert.ok(
    joystickClasses.length >= 7,
    "expected the joystick card rules to still be in the stylesheet",
  );
  const markup = (await browserSources())
    .map(([, source]) => renderedClassNames(stripComments(source)))
    .join(" ");
  const referenced = new Set(
    markup.split(/\s+/).filter((token) => token.includes("joystick")),
  );
  assert.deepEqual(
    joystickClasses.filter((name) => !referenced.has(name)),
    [],
    "unused joystick CSS: render the class or delete its rule",
  );
});
