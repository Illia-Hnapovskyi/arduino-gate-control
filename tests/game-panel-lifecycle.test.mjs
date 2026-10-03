import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { GAME_COPY, SPACE_DEFENDER_COPY } from "../app/i18n.ts";
import { validateRunSummary } from "../shared/gameStats.ts";

const require = createRequire(new URL("../app/GamePanel.tsx", import.meta.url));
const compile = async (path) => ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const panelCode = await compile("../app/GamePanel.tsx");
const overlayCode = await compile("../app/game/GameOverlays.tsx");
const noop = () => {};

function elements(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)];
}

// Exercise the actual component callbacks and runtime/adapter. Only browser
// effects and external hooks are replaced; no DOM or Supabase request is made.
function panelHarness(saveStatus = "queued") {
  const states = [];
  const refs = [];
  const records = [];
  const commands = [];
  const recoveryFiles = [];
  let stateIndex = 0;
  let refIndex = 0;
  let status = saveStatus;
  const hooks = {
    useEffect: noop,
    useCallback: (callback) => callback,
    useMemo: (callback) => callback(),
    useRef: (initial) => refs[refIndex++] ??= { current: initial },
    useState: (initial) => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    },
  };
  const stats = {
    profileOwnerId: "test-checkpoint-owner",
    profile: { highScore: 0, highestLevel: 1, gamesPlayed: 0, totalScore: 0, totalPlayTimeMs: 0 },
    progression: null,
    selectStatisticsSource: noop,
    recordRun: (run, owner) => { records.push({ run, owner }); return status; },
  };
  const modules = {
    react: hooks,
    "./auth/client": {},
    "./auth/useAuthSession": { useAuthSession: () => ({ sessionUserId: "test-account" }) },
    "./AccountPanel": { isGameRunActive: () => false },
    "./useGameStats": { useGameStats: () => stats },
    "./PlayerStatsPanel": { LeaderboardPanel: "LeaderboardPanel", PlayerStatsPanel: "PlayerStatsPanel", StatisticsSourceSelector: "StatisticsSourceSelector" },
    "./game/GameMenu": { GameMenu: "GameMenu", formatGameControlSummary: () => "" },
    "./game/GameHud": { GameHud: "GameHud" },
    "./game/GameOverlays": { GameOverlay: "GameOverlay", GameToastStack: "GameToastStack" },
    "./game/ProgressPanels": { AchievementGallery: "AchievementGallery", CareerStats: "CareerStats" },
    "./game/rendering": { renderGameWorld: noop },
    "./game/useControllerNavigation": { useControllerNavigation: noop },
    "./game/useGameAudio": { useGameAudio: () => ({ emitSfx: noop, unlockAudio: noop }) },
    "./game/useImmersiveStage": { useImmersiveStage: () => ({ active: false, isActive: () => false }) },
  };
  const exports = {};
  vm.runInNewContext(panelCode, {
    exports, performance, crypto, Blob,
    window: { localStorage: { getItem: () => null, removeItem: noop }, matchMedia: () => ({ matches: false }), setTimeout: () => 1 },
    URL: { createObjectURL: (blob) => { recoveryFiles.push(blob); return "blob:recovery-test"; } },
    document: { createElement: () => ({ click: noop, remove: noop }), body: { appendChild: noop } },
    require: (name) => modules[name] ?? require(name.startsWith(".") ? `${name}.ts` : name),
  });
  const render = () => {
    stateIndex = 0;
    refIndex = 0;
    return exports.default({ connection: "demo", language: "uk", joystickPressed: false, joystickX: 512, joystickY: 512,
      error: "", isSupported: false, onCommand: (command) => commands.push(command),
      onConnect: noop, onStartDemo: noop, onDataSafetyChange: noop });
  };
  const component = (name) => elements(render(), (element) => element.type === name)[0]?.props;
  const pause = () => {
    component("GameMenu").onStart();
    const button = elements(render(), (element) => element.type === "button" && element.props.children === GAME_COPY.uk.pause)[0];
    assert.ok(button, "a playing run exposes its existing pause control");
    button.props.onClick();
    assert.equal(component("GameOverlay").status, "paused");
  };
  return { component, pause, records, commands, recoveryFiles, setSaveStatus: (next) => { status = next; } };
}

test("pause to menu queues the original run once before navigating", () => {
  const harness = panelHarness();
  harness.pause();
  const leave = harness.component("GameOverlay").onPauseToMenu;
  leave();
  assert.ok(harness.component("GameMenu"));
  assert.equal(harness.component("GameOverlay"), undefined);
  assert.equal(harness.records.length, 1);
  assert.equal(harness.records[0].owner, "test-checkpoint-owner");
  assert.equal(harness.records[0].run.endedReason, "stopped");
  assert.equal(harness.records[0].run.statisticsSource, "demo");
  assert.equal(validateRunSummary(harness.records[0].run).ok, true);
  assert.equal(harness.commands.at(-1), "GAME:0");
  leave();
  assert.equal(harness.records.length, 1, "a stale double click cannot record twice");
});

test("failed pause-to-menu save retains, exports and retries the same run", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 8, 29) });
  const harness = panelHarness("storage-error");
  harness.pause();
  harness.component("GameOverlay").onPauseToMenu();
  let overlay = harness.component("GameOverlay");
  assert.equal(overlay.status, "over");
  assert.equal(overlay.result.saved, false);
  assert.equal(overlay.result.saveStatus, "storage-error");
  overlay.onBackToMenu();
  overlay.onPlayAgain();
  assert.equal(harness.component("GameOverlay").status, "over");
  assert.equal(harness.records.length, 1);
  t.mock.timers.tick(30_000);
  harness.component("GameOverlay").onExportRecovery();
  const recovery = JSON.parse(await harness.recoveryFiles[0].text());
  assert.deepEqual(recovery.run, harness.records[0].run);
  harness.setSaveStatus("queued");
  harness.component("GameOverlay").onRetrySave();
  overlay = harness.component("GameOverlay");
  assert.equal(overlay.result.saved, true);
  assert.equal(harness.records.length, 2);
  assert.deepEqual(harness.records[0], harness.records[1]);
  overlay.onBackToMenu();
  assert.ok(harness.component("GameMenu"));
});

test("every language renders one saved-result menu action and the pause menu action", () => {
  const exports = {};
  vm.runInNewContext(overlayCode, {
    exports,
    require: (name) => name === "react" ? { useEffect: noop, useRef: () => ({ current: null }) }
      : name === "./balance" ? require("./game/balance.ts") : require(name),
  });
  for (const copy of Object.values(SPACE_DEFENDER_COPY)) {
    const base = { copy, checkpointError: false, canPlayAgain: true, upgradeChoices: [], upgradeStacks: {}, onPauseToMenu: noop, onBackToMenu: noop };
    const result = { saved: true, endedReason: "stopped", score: 0, wave: 1, enemies: 0, bosses: 0,
      accuracy: 0, longestCombo: 0, durationSeconds: 0, unlockedAchievements: [] };
    const menuButtons = (tree) => elements(tree, (element) => element.type === "button" && element.props.children === copy.backToMenu);
    const paused = menuButtons(exports.GameOverlay({ ...base, status: "paused", result: null }));
    assert.equal(paused.length, 1);
    assert.equal(paused[0].props.onClick, base.onPauseToMenu);
    const saved = menuButtons(exports.GameOverlay({ ...base, status: "over", result }));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].props.onClick, base.onBackToMenu);
    assert.equal(menuButtons(exports.GameOverlay({ ...base, status: "over", result: { ...result, saved: false, saveStatus: "storage-error" } })).length, 0);
  }
});
