import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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

  // Sessions and the consent choice stay in localStorage; nothing sets cookies
  // and the one-time PKCE code is stripped before it is exchanged.
  for (const source of [statsPanel, accountPanel, page]) {
    assert.doesNotMatch(source, /document\.cookie/);
  }
  assert.match(accountPanel, /credentials: "omit"/);
  const stripIndex = page.indexOf("window.history.replaceState");
  const exchangeIndex = page.indexOf("exchangeCodeForSession");
  assert.ok(
    stripIndex > 0 && stripIndex < exchangeIndex,
    "the callback URL is stripped before the code is exchanged",
  );
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
