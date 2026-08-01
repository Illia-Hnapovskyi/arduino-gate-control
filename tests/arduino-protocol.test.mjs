import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const [firmware, instructions, audioModule, audioHook, gamePanelSource] = await Promise.all([
  readFile(path.join(projectRoot, "public/arduino-smart-gate.ino"), "utf8"),
  readFile(path.join(projectRoot, "public/README-UK.md"), "utf8"),
  readFile(path.join(projectRoot, "app/game/audio.ts"), "utf8"),
  readFile(path.join(projectRoot, "app/game/useGameAudio.ts"), "utf8"),
  readFile(path.join(projectRoot, "app/GamePanel.tsx"), "utf8"),
]);

const legacySfx = ["SHOT", "SCORE", "CRASH", "OVER"];
const addedSfx = [
  "POWER",
  "SHIELD",
  "BOSS",
  "WARN",
  "ACH",
  "LASER",
  "MISSILE",
  "EMP",
  "RECORD",
  "LOW",
  "MENU",
];
const allSfx = [...legacySfx, ...addedSfx];

function functionBody(source, functionName) {
  const signature = new RegExp(`\\bvoid\\s+${functionName}\\s*\\(`);
  const signatureMatch = signature.exec(source);
  assert.ok(signatureMatch, `missing ${functionName}()`);

  const openingBrace = source.indexOf("{", signatureMatch.index);
  assert.notEqual(openingBrace, -1, `missing body for ${functionName}()`);

  let depth = 0;
  for (let index = openingBrace; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}") {
      depth--;
      if (depth === 0) return source.slice(openingBrace + 1, index);
    }
  }

  assert.fail(`unterminated body for ${functionName}()`);
}

test("Arduino pin map, baud rate, and command limit remain compatible", () => {
  const pins = {
    SERVO_PIN: "9",
    TRIG_PIN: "7",
    ECHO_PIN: "6",
    BUZZER_PIN: "3",
    ACTIVE_BUZZER_PIN: "5",
    DHT_PIN: "2",
    JOYSTICK_X_PIN: "A0",
    JOYSTICK_Y_PIN: "A1",
    JOYSTICK_SW_PIN: "4",
  };

  for (const [name, value] of Object.entries(pins)) {
    assert.match(
      firmware,
      new RegExp(`const byte ${name} = ${value};`),
      `${name} moved from its documented pin`,
    );
  }

  assert.match(firmware, /Serial\.begin\(115200\);/);
  assert.match(firmware, /commandBuffer\.length\(\) < 40/);
  assert.match(instructions, /не більше 40 символів/);

  for (const command of [
    "GAME:PAUSE",
    "GAME:RESUME",
    "GAME:SOUND:1",
    "SFX:VOLUME:100",
    "TRACK:TONE:4000:1000",
    ...allSfx.map((effect) => `SFX:${effect}`),
  ]) {
    assert.ok(command.length < 40, `${command} exceeds the firmware buffer`);
  }
});

test("firmware and browser audio share all legacy and expanded SFX IDs", () => {
  const effectHandler = functionBody(firmware, "playGameEffect");
  const idsStart = audioModule.indexOf("export const GAME_SFX_IDS");
  const idsEnd = audioModule.indexOf("] as const;", idsStart);
  assert.ok(idsStart >= 0 && idsEnd > idsStart, "missing typed GAME_SFX_IDS");
  const typedIds = audioModule.slice(idsStart, idsEnd);

  for (const effect of allSfx) {
    assert.match(effectHandler, new RegExp(`effect == "${effect}"`));
    assert.match(typedIds, new RegExp(`"${effect}"`));
    assert.match(instructions, new RegExp(`\\| \`${effect}\` \\|`));
  }

  const volumeBranch = firmware.indexOf('command.startsWith("SFX:VOLUME:")');
  const effectBranch = firmware.indexOf('command.startsWith("SFX:")');
  assert.ok(volumeBranch >= 0 && effectBranch > volumeBranch);
  assert.match(firmware, /playGameEffect\(command\.substring\(4\)\)/);
  assert.match(effectHandler, /deviceMode != GAME_DEVICE/);
  assert.match(effectHandler, /!gameSoundEnabled/);
});

test("game effects use short millis-driven pulses without blocking the loop", () => {
  const effectPath = [
    functionBody(firmware, "startActiveBuzzerPattern"),
    functionBody(firmware, "playGameEffect"),
    functionBody(firmware, "updateActiveBuzzer"),
  ].join("\n");

  assert.doesNotMatch(effectPath, /\bdelay(?:Microseconds)?\s*\(/);
  assert.doesNotMatch(effectPath, /\bpulseIn\s*\(/);
  assert.doesNotMatch(effectPath, /\bwhile\s*\(/);
  assert.match(effectPath, /deadlineReached\(activeBuzzerNextMs\)/);
  assert.match(effectPath, /activeBuzzerPulsesRemaining/);
  assert.match(functionBody(firmware, "loop"), /updateActiveBuzzer\(\);/);

  const onDurations = [
    ...functionBody(firmware, "playGameEffect").matchAll(
      /onDuration\s*=\s*(\d+);/g,
    ),
  ].map((match) => Number(match[1]));
  const gapDurations = [
    ...functionBody(firmware, "playGameEffect").matchAll(
      /gapDuration\s*=\s*(\d+);/g,
    ),
  ].map((match) => Number(match[1]));
  const pulseCounts = [
    ...functionBody(firmware, "playGameEffect").matchAll(
      /pulseCount\s*=\s*(\d+);/g,
    ),
  ].map((match) => Number(match[1]));

  assert.ok(onDurations.length >= allSfx.length);
  assert.ok(Math.max(...onDurations) <= 500);
  assert.ok(Math.max(...gapDurations) <= 250);
  assert.ok(Math.max(...pulseCounts) <= 4);

  // These are the pre-existing sensor/setup waits. Any new blocking delay makes
  // this list change and requires an explicit hardware-safety review.
  assert.deepEqual(
    [...firmware.matchAll(/\bdelay\s*\((\d+)\)/g)].map((match) => match[1]),
    ["20", "300"],
  );
  assert.deepEqual(
    [...firmware.matchAll(/\bdelayMicroseconds\s*\((\d+)\)/g)].map(
      (match) => match[1],
    ),
    ["2", "10", "40"],
  );
  assert.match(firmware, /pulseIn\(ECHO_PIN, HIGH, 24000\)/);
});

test("audio module retains seven tracks and maps every planned sector", () => {
  for (const trackId of [
    "space",
    "neon",
    "boss",
    "joy",
    "elise",
    "bells",
    "anthem",
  ]) {
    assert.match(audioModule, new RegExp(`id: "${trackId}"`));
  }

  for (const sectorId of [
    "starfield",
    "nebula",
    "meteor-belt",
    "ice",
    "ion-storm",
    "ship-graveyard",
    "solar",
    "dark",
    "boss",
  ]) {
    assert.match(audioModule, new RegExp(`(?:"${sectorId}"|${sectorId}): \\{`));
  }

  assert.match(audioModule, /export function scheduleBrowserTrackStep/);
  assert.match(audioModule, /export function playBrowserGameSfx/);
  assert.match(audioModule, /export function createBrowserAudioEngine/);
  assert.match(audioModule, /export function gameSfxCommand/);
});

test("zero hardware music volume explicitly keeps the passive buzzer silent", () => {
  const serialMusicStart = audioHook.indexOf(
    'commandRef.current("TRACK:START")',
  );
  const zeroVolumeGuard = audioHook.indexOf(
    "preferencesRef.current.musicVolume <= 0",
    serialMusicStart,
  );
  const serialMusicStop = audioHook.indexOf(
    'commandRef.current("TRACK:STOP")',
    zeroVolumeGuard,
  );
  assert.ok(serialMusicStart >= 0);
  assert.ok(zeroVolumeGuard > serialMusicStart);
  assert.ok(serialMusicStop > zeroVolumeGuard);
});

test("the browser owns terminal SFX selection without the legacy overwrite", () => {
  assert.doesNotMatch(gamePanelSource, /commandRef\.current\("GAME:OVER"\)/);
  assert.match(gamePanelSource, /isNewRecord[\s\S]*\? "RECORD"/);
  assert.match(gamePanelSource, /commandRef\.current\("GAME:PAUSE"\)/);
  assert.match(
    functionBody(firmware, "playGameEffect"),
    /allowedWhilePaused[\s\S]*effect == "BOSS"/,
    "the victory cue must remain audible after the result screen pauses the game",
  );
});
