"use client";

import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import GamePanel from "./GamePanel";
import { GAME_COPY, LANGUAGE_OPTIONS, PAGE_COPY, type Language } from "./i18n";
import {
  AccountDialog,
  MIN_PASSWORD_LENGTH,
  setGameActivityBlocked,
} from "./AccountPanel";
import ConsentPanel from "./ConsentPanel";
import { completeAuthRedirect, type ConsentChoice } from "./auth/client";
import { authAvailable } from "./auth/supabaseConfig";
import {
  useAuthSession,
  type AuthActionResult,
} from "./auth/useAuthSession";
import type { PlayerStatsCopy } from "./PlayerStatsPanel";

type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "demo";

type GateMode = "manual" | "auto";
type DeviceMode = "gate" | "radar" | "game";
type MelodyId = 0 | 1 | 2 | 3;
type SiteTab = "control" | "game";

type RadarPoint = {
  angle: number;
  distance: number;
  recordedAt: number;
};

type SerialPortLike = {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
};

type SerialNavigator = Navigator & {
  serial?: {
    requestPort(): Promise<SerialPortLike>;
  };
};

type GateMessage = {
  distance?: number | null;
  temperature?: number | null;
  humidity?: number | null;
  dhtOk?: boolean;
  angle?: number;
  mode?: GateMode;
  gate?: "open" | "closed" | "moving";
  limit?: number;
  hold?: number;
  device?: DeviceMode;
  music?: MelodyId;
  scanSpeed?: number;
  joystickX?: number;
  joystickY?: number;
  joystickPressed?: boolean;
};

function isGateStatusMessage(message: GateMessage) {
  return (
    (message.device === "gate" ||
      message.device === "radar" ||
      message.device === "game") &&
    typeof message.angle === "number"
  );
}

const CLOSED_ANGLE = 10;
const OPEN_ANGLE = 90;
const RADAR_MIN_ANGLE = 15;
const RADAR_MAX_ANGLE = 165;
const RADAR_MAX_DISTANCE = 200;
const LANGUAGE_EVENT = "arduino-gate-language-change";

// The language this document was asked to show, held in memory as well as in
// the store. Routing `?lang=` through localStorage alone loses the parameter
// outright in a browser that allows reads and refuses writes — a private
// window, which is exactly where a link sent to an employer gets opened: the
// refused write is swallowed, the change event still fires, and readLanguage
// re-reads the OLD stored value, so the page paints Ukrainian for the German
// reader the parameter exists for. Preferring this over the store keeps the
// URL — and a click on a language button — in charge even when nothing can be
// persisted. It holds a plain string, so the useSyncExternalStore snapshot
// stays cheap and keeps returning the same value until something actually
// chooses another language.
let languageOverride: Language | null = null;

function readLanguage(): Language {
  if (typeof window === "undefined") return "uk";
  if (languageOverride) return languageOverride;
  try {
    const savedLanguage = window.localStorage.getItem("arduino-gate-language");
    return savedLanguage === "de" || savedLanguage === "en"
      ? savedLanguage
      : "uk";
  } catch {
    // This is the store snapshot, so a throw here happens during render and
    // takes the whole page down with it — and a document where reading storage
    // throws instead of merely refusing writes is a real one (a sandboxed
    // frame, blocked third-party storage). The in-memory language above already
    // had its turn, so the default is all that is left to fall back to.
    return "uk";
  }
}

function subscribeToLanguage(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== "arduino-gate-language") return;
    // Another tab just wrote a newer choice than whatever this document was
    // asked to show, so the in-memory language is stale: drop it and let the
    // snapshot read the store again. Cross-tab updates keep working as before.
    languageOverride = null;
    callback();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(LANGUAGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(LANGUAGE_EVENT, callback);
  };
}

function saveLanguage(language: Language) {
  // Recorded before the write and independently of whether it succeeds: this
  // is the value the next readLanguage answers with, so a refused write costs
  // persistence across visits and nothing about this one.
  languageOverride = language;
  try {
    window.localStorage.setItem("arduino-gate-language", language);
  } catch {
    // A store at quota or a private mode that allows reads and refuses writes
    // must cost persistence, never the page: this now also runs at module load
    // for `?lang=`, and a throw there aborts the import before src/main.tsx can
    // render anything at all. Same trade as saveConsentChoice in auth/client.ts.
  }
  window.dispatchEvent(new Event(LANGUAGE_EVENT));
}

// A link shared as `?lang=de` has to open in that language even in a browser
// that already stored another one, so the parameter wins on load and is then
// persisted through the normal store — the language buttons and later visits
// behave exactly as before. That same call also records it in memory, which is
// what makes the parameter win in a browser that refuses to keep it at all.
// Applying it at module load, before the first snapshot is read, keeps the page
// from painting the stored language first.
// `lang` stays in the address bar on purpose: the reader may pass the link on.
// An unknown or malformed value is ignored, which leaves the stored value —
// and finally "uk" — in charge.
function applyLanguageFromUrl() {
  if (typeof window === "undefined") return;
  const requested = new URLSearchParams(window.location.search).get("lang");
  const option = LANGUAGE_OPTIONS.find((entry) => entry.code === requested);
  if (option) saveLanguage(option.code);
}

applyLanguageFromUrl();

function radarCoordinates(angle: number, distance: number) {
  const radians = ((angle - 90) * Math.PI) / 180;
  const radius = Math.min(distance / RADAR_MAX_DISTANCE, 1) * 178;
  return {
    x: 210 + Math.sin(radians) * radius,
    y: 205 - Math.cos(radians) * radius,
  };
}

function nowLabel(language: Language) {
  const locale = language === "uk" ? "uk-UA" : language === "de" ? "de-DE" : "en-GB";
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
}

export default function Home() {
  const language = useSyncExternalStore<Language>(
    subscribeToLanguage,
    readLanguage,
    () => "uk",
  );
  const copy = PAGE_COPY[language];
  const gameCopy = GAME_COPY[language];
  const auth = useAuthSession();
  const [passwordResetOpen, setPasswordResetOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SiteTab>("control");
  const [gameDataAtRisk, setGameDataAtRisk] = useState(false);
  const [connection, setConnection] =
    useState<ConnectionState>("disconnected");
  const [mode, setMode] = useState<GateMode>("manual");
  const [deviceMode, setDeviceMode] = useState<DeviceMode>("gate");
  const [angle, setAngle] = useState(CLOSED_ANGLE);
  const [distance, setDistance] = useState<number | null>(null);
  const [temperature, setTemperature] = useState<number | null>(null);
  const [humidity, setHumidity] = useState<number | null>(null);
  const [dhtOk, setDhtOk] = useState(false);
  const [threshold, setThreshold] = useState(25);
  const [holdSeconds, setHoldSeconds] = useState(3);
  const [scanSpeed, setScanSpeed] = useState(45);
  const [melody, setMelody] = useState<MelodyId>(0);
  const [joystickX, setJoystickX] = useState(512);
  const [joystickY, setJoystickY] = useState(512);
  const [joystickPressed, setJoystickPressed] = useState(false);
  const [radarPoints, setRadarPoints] = useState<RadarPoint[]>([]);
  const [error, setError] = useState("");
  const [log, setLog] = useState<string[]>([]);

  const portRef = useRef<SerialPortLike | null>(null);
  const readerRef =
    useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const writerRef =
    useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const selectTabRef =
    useRef<((nextTab: SiteTab) => Promise<void>) | null>(null);
  const connectionAttemptRef = useRef(0);
  const closingPortRef = useRef(false);
  const statusMessageVersionRef = useRef(0);
  const latestStatusMessageRef = useRef<GateMessage | null>(null);
  const isSupported =
    typeof navigator !== "undefined" && "serial" in navigator;

  const addLog = useCallback((message: string) => {
    setLog((current) =>
      [`${nowLabel(language)} · ${message}`, ...current].slice(0, 6),
    );
  }, [language]);

  const resetConnectedState = useCallback(() => {
    setDistance(null);
    setTemperature(null);
    setHumidity(null);
    setDhtOk(false);
    setJoystickX(512);
    setJoystickY(512);
    setJoystickPressed(false);
    setMode("manual");
    setDeviceMode("gate");
    setMelody(0);
    setRadarPoints([]);
    setAngle(CLOSED_ANGLE);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = copy.documentTitle;
  }, [copy.documentTitle, language]);

  // Profile switching is blocked while the game reports data at risk — the
  // same signal that already locks the site tabs above.
  useEffect(() => {
    setGameActivityBlocked(gameDataAtRisk);
    return () => setGameActivityBlocked(false);
  }, [gameDataAtRisk]);

  const applyMessage = useCallback((message: GateMessage) => {
    if (typeof message.distance === "number") {
      setDistance(Math.round(message.distance * 10) / 10);
    } else if (message.distance === null) {
      setDistance(null);
    }
    if (typeof message.temperature === "number") {
      setTemperature(Math.round(message.temperature * 10) / 10);
    } else if (message.temperature === null) {
      setTemperature(null);
    }
    if (typeof message.humidity === "number") {
      setHumidity(Math.round(message.humidity * 10) / 10);
    } else if (message.humidity === null) {
      setHumidity(null);
    }
    if (typeof message.dhtOk === "boolean") setDhtOk(message.dhtOk);
    if (typeof message.angle === "number") setAngle(message.angle);
    if (message.mode === "manual" || message.mode === "auto") {
      setMode(message.mode);
    }
    if (typeof message.limit === "number") setThreshold(message.limit);
    if (typeof message.hold === "number") {
      setHoldSeconds(Math.round(message.hold / 100) / 10);
    }
    if (
      message.device === "gate" ||
      message.device === "radar" ||
      message.device === "game"
    ) {
      setDeviceMode(message.device);
    }
    if (
      message.music === 0 ||
      message.music === 1 ||
      message.music === 2 ||
      message.music === 3
    ) {
      setMelody(message.music);
    }
    if (typeof message.scanSpeed === "number") {
      setScanSpeed(message.scanSpeed);
    }
    if (typeof message.joystickX === "number") {
      setJoystickX(message.joystickX);
    }
    if (typeof message.joystickY === "number") {
      setJoystickY(message.joystickY);
    }
    if (typeof message.joystickPressed === "boolean") {
      setJoystickPressed(message.joystickPressed);
    }
    if (
      message.device === "radar" &&
      typeof message.distance === "number" &&
      message.distance > 0 &&
      message.distance <= RADAR_MAX_DISTANCE
    ) {
      const recordedAt = Date.now();
      setRadarPoints((points) =>
        [
          ...points.filter((point) => recordedAt - point.recordedAt < 4200),
          {
            angle: message.angle ?? 90,
            distance: message.distance as number,
            recordedAt,
          },
        ].slice(-48),
      );
    }
  }, []);

  const closePortResources = useCallback(
    async (requestedPort: SerialPortLike | null) => {
      if (requestedPort && portRef.current && portRef.current !== requestedPort) {
        try {
          await requestedPort.close();
        } catch {
          // This is an old port from a superseded connection attempt.
        }
        return;
      }

      const port = requestedPort ?? portRef.current;
      const reader = readerRef.current;
      readerRef.current = null;
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          // The USB device may already be gone.
        }
        try {
          reader.releaseLock();
        } catch {
          // The read loop may already have released the lock.
        }
      }

      const writer = writerRef.current;
      writerRef.current = null;
      try {
        writer?.releaseLock();
      } catch {
        // The writer may already have been released after a port failure.
      }

      if (portRef.current === port) portRef.current = null;
      try {
        await port?.close();
      } catch {
        // Closing an unplugged or already closed port is safe to ignore.
      }
    },
    [],
  );

  const readFromPort = useCallback(
    async (port: SerialPortLike) => {
      if (!port.readable) return;
      const reader = port.readable.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      let readFailure: unknown = null;

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            readFailure = new Error(copy.logConnectionInterrupted);
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const message = JSON.parse(trimmed) as GateMessage;
              applyMessage(message);
              if (isGateStatusMessage(message)) {
                latestStatusMessageRef.current = message;
                statusMessageVersionRef.current++;
              }
            } catch {
              addLog(trimmed);
            }
          }
        }
      } catch (readError) {
        readFailure = readError;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // The lock may already be released during a manual disconnect.
        }
        if (readerRef.current === reader) readerRef.current = null;
      }

      if (!closingPortRef.current && portRef.current === port) {
        connectionAttemptRef.current++;
        closingPortRef.current = true;
        await closePortResources(port);
        resetConnectedState();
        setConnection("disconnected");
        addLog(copy.logConnectionInterrupted);
        setError(
          readFailure instanceof Error
            ? readFailure.message
            : copy.errorRead,
        );
        closingPortRef.current = false;
      }
    },
    [
      addLog,
      applyMessage,
      closePortResources,
      copy.errorRead,
      copy.logConnectionInterrupted,
      resetConnectedState,
    ],
  );

  const writeLine = useCallback(async (command: string) => {
    const writer = writerRef.current;
    if (!writer) throw new Error("Serial writer is unavailable");
    await writer.write(new TextEncoder().encode(`${command}\n`));
  }, []);

  const sendCommand = useCallback(
    async (command: string, friendlyMessage?: string) => {
      setError("");
      if (connection === "demo") {
        if (friendlyMessage) addLog(`${friendlyMessage} (${copy.demoSuffix})`);
        return true;
      }
      if (connection !== "connected") {
        setError(copy.errorConnectFirst);
        return false;
      }
      try {
        await writeLine(command);
        if (friendlyMessage) addLog(friendlyMessage);
        return true;
      } catch {
        setError(copy.errorCommand);
        if (!closingPortRef.current && portRef.current) {
          connectionAttemptRef.current++;
          closingPortRef.current = true;
          await closePortResources(portRef.current);
          resetConnectedState();
          setConnection("disconnected");
          addLog(copy.logConnectionInterrupted);
          closingPortRef.current = false;
        }
        return false;
      }
    },
    [
      addLog,
      closePortResources,
      connection,
      copy.demoSuffix,
      copy.errorCommand,
      copy.errorConnectFirst,
      copy.logConnectionInterrupted,
      resetConnectedState,
      writeLine,
    ],
  );

  const connect = async () => {
    if (connection === "connecting") return;
    setError("");
    if (!isSupported) {
      setError(copy.errorSerial);
      return;
    }

    const connectionAttempt = ++connectionAttemptRef.current;
    let port: SerialPortLike | null = null;
    closingPortRef.current = false;
    setConnection("connecting");
    try {
      const serial = (navigator as SerialNavigator).serial;
      if (!serial) throw new Error(copy.errorSerialUnavailable);
      port = await serial.requestPort();
      if (connectionAttempt !== connectionAttemptRef.current) return;
      await port.open({ baudRate: 115200 });
      if (connectionAttempt !== connectionAttemptRef.current) {
        await closePortResources(port);
        return;
      }
      portRef.current = port;
      if (!port.readable) throw new Error(copy.errorRead);
      if (!port.writable) throw new Error(copy.errorPortWrite);
      writerRef.current = port.writable.getWriter();
      void readFromPort(port);

      const waitForStatus = async (
        afterVersion: number,
        matches: (message: GateMessage) => boolean,
        retries: number,
      ) => {
        for (let retry = 0; retry < retries; retry++) {
          if (connectionAttempt !== connectionAttemptRef.current) return false;
          const latestStatus = latestStatusMessageRef.current;
          if (
            statusMessageVersionRef.current > afterVersion &&
            latestStatus &&
            matches(latestStatus)
          ) {
            return true;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        return false;
      };

      // Arduino Uno usually resets when a serial port is opened.
      await new Promise((resolve) => window.setTimeout(resolve, 1700));
      if (
        connectionAttempt !== connectionAttemptRef.current ||
        portRef.current !== port ||
        !writerRef.current
      ) {
        return;
      }

      // Wait until the sketch itself is responding, not merely until the USB
      // port has opened. Slow bootloaders may need longer than the usual reset.
      const readyVersion = statusMessageVersionRef.current;
      await writeLine("STATUS");
      const boardReady = await waitForStatus(readyVersion, () => true, 80);
      if (!boardReady) throw new Error(copy.errorRead);

      const configurationVersion = statusMessageVersionRef.current;
      await writeLine(`LIMIT:${threshold}`);
      await writeLine(`HOLD:${Math.round(holdSeconds * 1000)}`);
      await writeLine(`SCAN:${scanSpeed}`);
      await writeLine(`RADAR:${deviceMode === "radar" ? 1 : 0}`);
      await writeLine(`AUTO:${mode === "auto" ? 1 : 0}`);
      await writeLine("STATUS");

      if (connectionAttempt !== connectionAttemptRef.current) return;
      const expectedHold = Math.round(holdSeconds * 1000);
      const expectedDevice =
        deviceMode === "radar" && mode !== "auto" ? "radar" : "gate";
      const configurationApplied = await waitForStatus(
        configurationVersion,
        (message) =>
          message.limit === threshold &&
          message.hold === expectedHold &&
          message.scanSpeed === scanSpeed &&
          message.device === expectedDevice &&
          message.mode === mode,
        40,
      );
      if (!configurationApplied) {
        throw new Error(copy.errorRead);
      }
      setConnection("connected");
      addLog(copy.logConnected);
    } catch (connectError) {
      if (connectionAttempt !== connectionAttemptRef.current) return;
      closingPortRef.current = true;
      await closePortResources(port);
      resetConnectedState();
      setConnection("disconnected");
      setError(
        connectError instanceof Error && connectError.name === "NotFoundError"
          ? copy.errorNoBoard
          : copy.errorOpenPort,
      );
      closingPortRef.current = false;
    }
  };

  const disconnect = useCallback(async () => {
    connectionAttemptRef.current++;
    closingPortRef.current = true;
    if (writerRef.current) {
      for (const command of ["MUSIC:STOP", "GAME:0", "RADAR:0"]) {
        try {
          await writeLine(command);
        } catch {
          break;
        }
      }
    }
    await closePortResources(portRef.current);
    resetConnectedState();
    setConnection("disconnected");
    setError("");
    addLog(copy.logDisconnected);
    closingPortRef.current = false;
  }, [
    addLog,
    closePortResources,
    copy.logDisconnected,
    resetConnectedState,
    writeLine,
  ]);

  const disposePort = useCallback(() => {
    connectionAttemptRef.current++;
    closingPortRef.current = true;
    void closePortResources(portRef.current);
  }, [closePortResources]);

  useEffect(() => {
    return disposePort;
  }, [disposePort]);

  useEffect(() => {
    if (connection !== "demo") return;
    let demoAngle = RADAR_MIN_ANGLE;
    let demoDirection = 1;
    let lastDemoObjectSeenMs = Date.now();
    const interval = window.setInterval(() => {
      if (deviceMode === "radar") {
        demoAngle += demoDirection * 2;
        if (demoAngle >= RADAR_MAX_ANGLE) {
          demoAngle = RADAR_MAX_ANGLE;
          demoDirection = -1;
        } else if (demoAngle <= RADAR_MIN_ANGLE) {
          demoAngle = RADAR_MIN_ANGLE;
          demoDirection = 1;
        }
        const simulated =
          34 +
          Math.abs(Math.sin((demoAngle / 180) * Math.PI * 2)) * 92 +
          Math.random() * 8;
        const roundedDistance = Math.round(simulated * 10) / 10;
        setAngle(demoAngle);
        setDistance(roundedDistance);
        setRadarPoints((points) =>
          [
            ...points.filter(
              (point) => Date.now() - point.recordedAt < 4200,
            ),
            {
              angle: demoAngle,
              distance: roundedDistance,
              recordedAt: Date.now(),
            },
          ].slice(-48),
        );
      } else {
        const phase = Date.now() / 1800;
        const simulated = Math.max(
          7,
          Math.min(
            95,
            46 + Math.sin(phase) * 34 + (Math.random() - 0.5) * 4,
          ),
        );
        setDistance(Math.round(simulated * 10) / 10);
        if (mode === "auto") {
          if (simulated <= threshold) {
            lastDemoObjectSeenMs = Date.now();
            setAngle(OPEN_ANGLE);
          } else if (
            Date.now() - lastDemoObjectSeenMs >= holdSeconds * 1000
          ) {
            setAngle(CLOSED_ANGLE);
          }
        }
      }

      const climatePhase = Date.now() / 9000;
      setTemperature(
        Math.round((23.4 + Math.sin(climatePhase) * 1.8) * 10) / 10,
      );
      setHumidity(
        Math.round((48 + Math.cos(climatePhase * 0.8) * 7) * 10) / 10,
      );
      setDhtOk(true);
    }, deviceMode === "radar" ? scanSpeed : 350);
    return () => window.clearInterval(interval);
  }, [connection, deviceMode, holdSeconds, mode, scanSpeed, threshold]);

  useEffect(() => {
    if (deviceMode !== "radar") return;

    const pruneExpiredPoints = () => {
      const cutoff = Date.now() - 4200;
      setRadarPoints((points) => {
        const recentPoints = points.filter(
          (point) => point.recordedAt >= cutoff,
        );
        return recentPoints.length === points.length ? points : recentPoints;
      });
    };

    const interval = window.setInterval(pruneExpiredPoints, 500);
    return () => window.clearInterval(interval);
  }, [deviceMode]);

  const startDemo = () => {
    if (connection === "connecting") return;
    setError("");
    setConnection("demo");
    setDistance(48);
    setTemperature(23.4);
    setHumidity(48);
    setDhtOk(true);
    setJoystickX(512);
    setJoystickY(512);
    setJoystickPressed(false);
    addLog(copy.logDemoStarted);
  };

  const stopDemo = () => {
    resetConnectedState();
    setConnection("disconnected");
    addLog(copy.logDemoStopped);
  };

  const setGateAngle = async (nextAngle: number) => {
    if (connection !== "connected" && connection !== "demo") {
      setError(copy.errorConnectFirst);
      return;
    }
    if (deviceMode === "radar") {
      if (!(await sendCommand("RADAR:0"))) return;
    } else if (deviceMode === "game") {
      if (!(await sendCommand("GAME:0"))) return;
    }
    if (!(await sendCommand("AUTO:0"))) return;
    if (
      !(await sendCommand(
        `ANGLE:${nextAngle}`,
        copy.gateAngleLog(nextAngle),
      ))
    ) {
      return;
    }
    setDeviceMode("gate");
    setAngle(nextAngle);
    setMode("manual");
  };

  const setAutomaticMode = async (automatic: boolean) => {
    if (connection !== "connected" && connection !== "demo") {
      setError(copy.errorConnectFirst);
      return;
    }
    if (deviceMode === "radar") {
      if (!(await sendCommand("RADAR:0"))) return;
    } else if (deviceMode === "game") {
      if (!(await sendCommand("GAME:0"))) return;
    }
    const nextMode: GateMode = automatic ? "auto" : "manual";
    if (
      !(await sendCommand(
        `AUTO:${automatic ? 1 : 0}`,
        automatic ? copy.autoOnLog : copy.autoOffLog,
      ))
    ) {
      return;
    }
    setDeviceMode("gate");
    setMode(nextMode);
  };

  const changeThreshold = async (value: number) => {
    setThreshold(value);
    setError("");
    if (connection === "connected" || connection === "demo") {
      await sendCommand(`LIMIT:${value}`);
    }
  };

  const changeHold = async (value: number) => {
    setHoldSeconds(value);
    setError("");
    if (connection === "connected" || connection === "demo") {
      await sendCommand(`HOLD:${Math.round(value * 1000)}`);
    }
  };

  const startRadar = async () => {
    if (connection !== "connected" && connection !== "demo") {
      setError(copy.errorConnectFirst);
      return;
    }
    if (deviceMode === "game") {
      if (!(await sendCommand("GAME:0"))) return;
    }
    if (!(await sendCommand("AUTO:0"))) return;
    if (!(await sendCommand("RADAR:1", copy.radarStartLog))) return;
    setDeviceMode("radar");
    setMode("manual");
    setRadarPoints([]);
    setAngle(RADAR_MIN_ANGLE);
  };

  const stopRadar = async () => {
    if (connection !== "connected" && connection !== "demo") {
      setError(copy.errorConnectFirst);
      return;
    }
    if (!(await sendCommand("RADAR:0", copy.radarStopLog))) return;
    setDeviceMode("gate");
    setMode("manual");
    setAngle(CLOSED_ANGLE);
  };

  const changeScanSpeed = async (value: number) => {
    setScanSpeed(value);
    setError("");
    if (connection === "connected" || connection === "demo") {
      await sendCommand(`SCAN:${value}`);
    }
  };

  const playMelody = async (id: MelodyId, title: string) => {
    if (connection !== "connected" && connection !== "demo") {
      setError(copy.errorConnectFirst);
      return;
    }
    if (!(await sendCommand(`MUSIC:${id}`, copy.melodyLog(title)))) return;
    setMelody(id);
  };

  const stopMusic = async () => {
    if (connection !== "connected" && connection !== "demo") {
      setError(copy.errorConnectFirst);
      return;
    }
    if (!(await sendCommand("MUSIC:STOP", copy.musicStopLog))) return;
    setMelody(0);
  };

  const selectTab = async (nextTab: SiteTab) => {
    if (nextTab === activeTab) return;
    if (nextTab === "control" && activeTab === "game" && gameDataAtRisk) {
      return;
    }

    if (nextTab === "game") {
      if (connection === "connected" || connection === "demo") {
        const autoStopped = await sendCommand("AUTO:0");
        if (autoStopped) await sendCommand("RADAR:0");
      }
      setMode("manual");
      setDeviceMode("gate");
    } else if (activeTab === "game") {
      if (connection === "connected" || connection === "demo") {
        await sendCommand("GAME:0");
      }
      setDeviceMode("gate");
    }

    setActiveTab(nextTab);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // `selectTab` is a fresh closure on every render, so the mount-only redirect
  // effect below reaches the current one through a ref instead of re-running
  // whenever that identity changes. This effect is declared first, so the ref
  // is populated before the redirect can settle.
  useEffect(() => {
    selectTabRef.current = selectTab;
  });

  // The provider redirect is completed in exactly one place: client.ts strips
  // the one-time code before its first await and memoises the exchange, so this
  // effect only reacts to the outcome, and StrictMode's second mount sees the
  // same settled result instead of a spent code.
  useEffect(() => {
    let active = true;
    void completeAuthRedirect().then((redirect) => {
      if (!active) return;
      // Only a redirect that actually established a session can set a new
      // password; anything else leaves the account panel offering sign-in.
      if (redirect.passwordReset && redirect.kind === "signed-in") {
        setPasswordResetOpen(true);
      }
      // Go through selectTab rather than setActiveTab: entering the game tab
      // has to stop auto and radar mode on the board first, exactly as a click
      // on the tab does.
      if (redirect.view === "game") void selectTabRef.current?.("game");
    });
    return () => {
      active = false;
    };
  }, []);

  const sendGameCommand = useCallback(
    (command: string) => {
      if (command === "GAME:1") setDeviceMode("game");
      if (command === "GAME:0") setDeviceMode("gate");
      void sendCommand(command);
    },
    [sendCommand],
  );

  const gateIsOpen = deviceMode === "gate" && angle >= 55;
  const climateHasData =
    dhtOk && temperature !== null && humidity !== null;
  const currentRadarTarget =
    distance !== null ? radarCoordinates(angle, distance) : null;
  const statusText = useMemo(() => {
    if (connection === "connected") return copy.statusConnected;
    if (connection === "connecting") return copy.statusConnecting;
    if (connection === "demo") return copy.statusDemo;
    return copy.statusDisconnected;
  }, [
    connection,
    copy.statusConnected,
    copy.statusConnecting,
    copy.statusDemo,
    copy.statusDisconnected,
  ]);

  const gateStyle = {
    "--gate-rotation": `${-(angle / OPEN_ANGLE) * 78}deg`,
  } as CSSProperties;

  const handleConsentChoice = (choice: ConsentChoice) => {
    auth.chooseConsent(choice);
    if (choice === "account") void selectTab("game");
  };

  return (
    <main className="site-shell" lang={language}>
      <header className="topbar">
        <a
          className="brand"
          href="#control"
          aria-label={copy.brandAria}
          onClick={(event) => {
            event.preventDefault();
            void selectTab("control");
          }}
        >
          <span className="brand-mark" aria-hidden="true">∞</span>
          <span>
            <strong>ARDUINO GATE</strong>
            <small>{copy.brandSubtitle}</small>
          </span>
        </a>
        <nav className="site-tabs" aria-label={copy.navLabel}>
          <button
            className={activeTab === "control" ? "active" : ""}
            aria-current={activeTab === "control" ? "page" : undefined}
            disabled={activeTab === "game" && gameDataAtRisk}
            onClick={() => void selectTab("control")}
          >
            {copy.controlTab}
          </button>
          <button
            className={activeTab === "game" ? "active" : ""}
            aria-current={activeTab === "game" ? "page" : undefined}
            onClick={() => void selectTab("game")}
          >
            {copy.gameTab}
            <span>{copy.newBadge}</span>
          </button>
        </nav>
        <div className="topbar-actions">
          <div
            aria-label={statusText}
            className={`connection-pill ${connection}`}
            role="status"
          >
            <span className="status-dot" aria-hidden="true" />
            <span className="status-label">{statusText}</span>
          </div>
          <div
            aria-label={copy.languageLabel}
            className="language-switcher"
            role="group"
          >
            {LANGUAGE_OPTIONS.map((option) => (
              <button
                aria-pressed={language === option.code}
                className={language === option.code ? "active" : ""}
                key={option.code}
                onClick={() => {
                  setError("");
                  setLog([]);
                  saveLanguage(option.code);
                }}
                title={option.label}
                type="button"
              >
                {option.shortLabel}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div hidden={activeTab !== "control"}>
      <section className="hero" id="control">
        <div className="hero-copy">
          <p className="eyebrow">UNO · SG90 · HC-SR04 · BUZZER · USB</p>
          <h1>{copy.heroTitle}</h1>
          <p className="hero-lead">{copy.heroLead}</p>
          <div className="hero-actions">
            {connection === "disconnected" ? (
              <>
                <button className="button primary" onClick={connect}>
                  <span aria-hidden="true">⌁</span> {copy.connectArduino}
                </button>
                <button className="button secondary" onClick={startDemo}>
                  {copy.tryDemo}
                </button>
              </>
            ) : connection === "demo" ? (
              <button className="button secondary" onClick={stopDemo}>
                {copy.exitDemo}
              </button>
            ) : (
              <button className="button secondary" onClick={disconnect}>
                {copy.disconnect}
              </button>
            )}
          </div>
          {!isSupported && (
            <p className="browser-note">{copy.browserNote}</p>
          )}
          {error && <p className="error-message" role="alert">{error}</p>}
        </div>

        <div
          className={`mechanism-card ${deviceMode === "radar" ? "radar-active" : ""}`}
          aria-label={
            deviceMode === "radar" ? copy.radarStateAria : copy.gateStateAria
          }
        >
          <div className="mechanism-head">
            <div>
              <span className="muted-label">{copy.mechanismStatus}</span>
              <strong>
                {deviceMode === "radar"
                  ? copy.scanning
                  : gateIsOpen
                    ? copy.opened
                    : copy.closed}
              </strong>
            </div>
            <div
              className={`state-light ${gateIsOpen || deviceMode === "radar" ? "open" : ""}`}
            />
          </div>

          {deviceMode === "radar" ? (
            <div className="hero-radar-scene">
              <svg
                viewBox="0 0 420 220"
                role="img"
                aria-label={copy.radarAria(angle, distance ?? 0)}
              >
                <path className="scope-arc" d="M30 205 A180 180 0 0 1 390 205" />
                <path className="scope-arc" d="M75 205 A135 135 0 0 1 345 205" />
                <path className="scope-arc" d="M120 205 A90 90 0 0 1 300 205" />
                <path className="scope-arc" d="M165 205 A45 45 0 0 1 255 205" />
                <line className="scope-axis" x1="210" y1="205" x2="30" y2="205" />
                <line className="scope-axis" x1="210" y1="205" x2="210" y2="25" />
                <line className="scope-axis" x1="210" y1="205" x2="390" y2="205" />
                <line
                  className="scope-sweep"
                  x1="210"
                  y1="205"
                  x2={210 + Math.sin(((angle - 90) * Math.PI) / 180) * 180}
                  y2={205 - Math.cos(((angle - 90) * Math.PI) / 180) * 180}
                />
                {radarPoints.map((point, index) => {
                  const coordinates = radarCoordinates(
                    point.angle,
                    point.distance,
                  );
                  return (
                    <circle
                      className="scope-trail"
                      cx={coordinates.x}
                      cy={coordinates.y}
                      key={`${point.recordedAt}-${index}`}
                      r="3"
                    />
                  );
                })}
                {currentRadarTarget && distance !== null && (
                  <circle
                    className="scope-target"
                    cx={currentRadarTarget.x}
                    cy={currentRadarTarget.y}
                    r="6"
                  />
                )}
              </svg>
              <div className="hero-radar-labels">
                <span>15°</span>
                <strong>HC-SR04</strong>
                <span>165°</span>
              </div>
            </div>
          ) : (
            <div className="gate-scene">
              <div className="sensor">
                <span className="sensor-eye" />
                <span className="sensor-eye" />
                <i className="wave wave-one" />
                <i className="wave wave-two" />
                <i className="wave wave-three" />
              </div>
              <div className="gate-post">
                <div className="gate-pivot">
                  <div className="gate-arm" style={gateStyle}>
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </div>
              <div className="road-line road-one" />
              <div className="road-line road-two" />
            </div>
          )}

          <div className="readouts">
            <div>
              <span>{copy.distance}</span>
              <strong>{distance === null ? "—" : distance.toFixed(1)}<small> {copy.cm}</small></strong>
            </div>
            <div>
              <span>{copy.angle}</span>
              <strong>{angle}<small>°</small></strong>
            </div>
            <div>
              <span>{copy.mode}</span>
              <strong className="mode-readout">
                {deviceMode === "radar"
                  ? "RADAR"
                  : mode === "auto"
                    ? "AUTO"
                    : "MANUAL"}
              </strong>
            </div>
          </div>
        </div>
      </section>

      <section className="dashboard-section">
        <div className="section-title">
          <p className="eyebrow">{copy.dashboardEyebrow}</p>
          <h2>{copy.dashboardTitle}</h2>
        </div>

        <div className="dashboard-grid">
          <article className="control-card manual-card">
            <div className="card-number">01</div>
            <div className="card-heading">
              <div>
                <p>{copy.manualEyebrow}</p>
                <h3>{copy.servoPosition}</h3>
              </div>
              <span className="angle-badge">{angle}°</span>
            </div>

            <label className="range-label" htmlFor="angle">
              <span>{copy.closedLabel}</span>
              <span>{copy.openLabel}</span>
            </label>
            <input
              id="angle"
              className="range"
              type="range"
              min={CLOSED_ANGLE}
              max={OPEN_ANGLE}
              value={angle}
              disabled={mode === "auto"}
              onChange={(event) => void setGateAngle(Number(event.target.value))}
            />
            <div className="quick-actions">
              <button onClick={() => void setGateAngle(CLOSED_ANGLE)}>
                {copy.closeButton}
              </button>
              <button onClick={() => void setGateAngle(45)}>
                {copy.halfButton}
              </button>
              <button onClick={() => void setGateAngle(OPEN_ANGLE)}>
                {copy.openButton}
              </button>
            </div>
          </article>

          <article className="control-card auto-card">
            <div className="card-number">02</div>
            <div className="card-heading">
              <div>
                <p>{copy.autoEyebrow}</p>
                <h3>{copy.autoTitle}</h3>
              </div>
              <button
                className={`toggle ${mode === "auto" ? "active" : ""}`}
                role="switch"
                aria-checked={mode === "auto"}
                aria-label={copy.autoAria}
                onClick={() => void setAutomaticMode(mode !== "auto")}
              >
                <span />
              </button>
            </div>

            <div className="setting-row">
              <div>
                <label htmlFor="threshold">{copy.thresholdLabel}</label>
                <small>{copy.thresholdHint}</small>
              </div>
              <output>{threshold} {copy.cm}</output>
            </div>
            <input
              id="threshold"
              className="range compact"
              type="range"
              min="8"
              max="80"
              value={threshold}
              onChange={(event) => void changeThreshold(Number(event.target.value))}
            />

            <div className="setting-row hold-row">
              <div>
                <label htmlFor="hold">{copy.holdLabel}</label>
                <small>{copy.holdHint}</small>
              </div>
              <select
                id="hold"
                value={holdSeconds}
                onChange={(event) => void changeHold(Number(event.target.value))}
              >
                <option value="1">1 {copy.secondsShort}</option>
                <option value="3">3 {copy.secondsShort}</option>
                <option value="5">5 {copy.secondsShort}</option>
                <option value="10">10 {copy.secondsShort}</option>
              </select>
            </div>
          </article>

          <article className="control-card terminal-card">
            <div className="card-number">03</div>
            <div className="card-heading">
              <div>
                <p>{copy.journal}</p>
                <h3>{copy.lastEvents}</h3>
              </div>
              <span className="live-badge">LIVE</span>
            </div>
            <div className="terminal">
              {(log.length > 0
                ? log
                : [copy.logReady]
              ).map((entry, index) => (
                <p key={`${entry}-${index}`}>
                  <span>&gt;</span> {entry}
                </p>
              ))}
            </div>
          </article>
        </div>
      </section>

      <section className="radar-music-section" id="radar">
        <div className="section-title">
          <p className="eyebrow">{copy.updateEyebrow}</p>
          <h2>{copy.radarMusicTitle}</h2>
          <p>{copy.radarMusicIntro}</p>
        </div>

        <div className="radar-music-grid">
          <article className="radar-control-card">
            <div className="feature-card-head">
              <div>
                <p>{copy.radarEyebrow}</p>
                <h3>{copy.scanTitle}</h3>
              </div>
              <span className={`feature-status ${deviceMode === "radar" ? "active" : ""}`}>
                {deviceMode === "radar" ? copy.scanningStatus : copy.readyStatus}
              </span>
            </div>

            <div className="radar-scope">
              <svg
                viewBox="0 0 420 220"
                role="img"
                aria-label={copy.radarMapAria}
              >
                <path className="scope-arc" d="M30 205 A180 180 0 0 1 390 205" />
                <path className="scope-arc" d="M75 205 A135 135 0 0 1 345 205" />
                <path className="scope-arc" d="M120 205 A90 90 0 0 1 300 205" />
                <path className="scope-arc" d="M165 205 A45 45 0 0 1 255 205" />
                <line className="scope-axis" x1="210" y1="205" x2="30" y2="205" />
                <line className="scope-axis" x1="210" y1="205" x2="210" y2="25" />
                <line className="scope-axis" x1="210" y1="205" x2="390" y2="205" />
                <line
                  className="scope-sweep"
                  x1="210"
                  y1="205"
                  x2={210 + Math.sin(((angle - 90) * Math.PI) / 180) * 180}
                  y2={205 - Math.cos(((angle - 90) * Math.PI) / 180) * 180}
                />
                {radarPoints.map((point, index) => {
                  const coordinates = radarCoordinates(
                    point.angle,
                    point.distance,
                  );
                  return (
                    <circle
                      className="scope-trail"
                      cx={coordinates.x}
                      cy={coordinates.y}
                      key={`large-${point.recordedAt}-${index}`}
                      r="3"
                    />
                  );
                })}
                {currentRadarTarget && distance !== null && (
                  <circle
                    className="scope-target"
                    cx={currentRadarTarget.x}
                    cy={currentRadarTarget.y}
                    r="7"
                  />
                )}
              </svg>
              <div className="radar-scale">
                <span>0 {copy.cm}</span>
                <span>100 {copy.cm}</span>
                <span>200 {copy.cm}</span>
              </div>
            </div>

            <div className="radar-stats">
              <div>
                <span>{copy.angle}</span>
                <strong>{angle}°</strong>
              </div>
              <div>
                <span>{copy.object}</span>
                <strong>{distance === null ? "—" : `${distance.toFixed(1)} ${copy.cm}`}</strong>
              </div>
              <div>
                <span>{copy.speed}</span>
                <strong>{scanSpeed} {copy.millisecondsShort}</strong>
              </div>
            </div>

            <div className="scan-controls">
              <label htmlFor="scan-speed">
                {copy.scanSpeed}
                <small>{copy.scanSpeedHint}</small>
              </label>
              <input
                id="scan-speed"
                className="range compact"
                type="range"
                min="30"
                max="100"
                step="5"
                value={scanSpeed}
                onChange={(event) =>
                  void changeScanSpeed(Number(event.target.value))
                }
              />
              {deviceMode === "radar" ? (
                <button className="button radar-stop" onClick={() => void stopRadar()}>
                  {copy.stopRadar}
                </button>
              ) : (
                <button className="button radar-start" onClick={() => void startRadar()}>
                  {copy.startScan}
                </button>
              )}
            </div>
          </article>

          <article className="music-control-card">
            <div className="feature-card-head">
              <div>
                <p>{copy.buzzerEyebrow}</p>
                <h3>{copy.musicDuringScan}</h3>
              </div>
              <span className={`feature-status music ${melody !== 0 ? "active" : ""}`}>
                {melody !== 0 ? copy.playing : copy.silence}
              </span>
            </div>

            <div className={`speaker-visual ${melody !== 0 ? "playing" : ""}`}>
              <div className="speaker-cone">
                <span />
              </div>
              <i className="sound-ring ring-one" />
              <i className="sound-ring ring-two" />
              <i className="sound-ring ring-three" />
              <div className="equalizer" aria-hidden="true">
                <b />
                <b />
                <b />
                <b />
                <b />
                <b />
              </div>
            </div>

            <div className="melody-list">
              <button
                className={melody === 1 ? "selected" : ""}
                onClick={() => void playMelody(1, copy.melodyOne)}
              >
                <span>01</span>
                <div>
                  <strong>{copy.melodyOne}</strong>
                  <small>{copy.melodyOneHint}</small>
                </div>
                <i>▶</i>
              </button>
              <button
                className={melody === 2 ? "selected" : ""}
                onClick={() => void playMelody(2, copy.melodyTwo)}
              >
                <span>02</span>
                <div>
                  <strong>{copy.melodyTwo}</strong>
                  <small>{copy.melodyTwoHint}</small>
                </div>
                <i>▶</i>
              </button>
              <button
                className={melody === 3 ? "selected" : ""}
                onClick={() => void playMelody(3, copy.melodyThree)}
              >
                <span>03</span>
                <div>
                  <strong>{copy.melodyThree}</strong>
                  <small>{copy.melodyThreeHint}</small>
                </div>
                <i>▶</i>
              </button>
            </div>

            <button
              className="button music-stop"
              disabled={melody === 0}
              onClick={() => void stopMusic()}
            >
              {copy.stopMusic}
            </button>

            <aside className="buzzer-hint">
              <span>+</span>
              <p>{copy.buzzerHint}</p>
            </aside>
          </article>
        </div>
      </section>

      <section className="climate-section" id="climate">
        <div className="section-title">
          <p className="eyebrow">{copy.climateEyebrow}</p>
          <h2>{copy.climateTitle}</h2>
          <p>{copy.climateIntro}</p>
        </div>

        <div className="climate-grid">
          <article className="climate-monitor">
            <div className="climate-monitor-head">
              <div>
                <span>{copy.microclimate}</span>
                <strong>DHT11</strong>
              </div>
              <span className={`sensor-state ${climateHasData ? "online" : ""}`}>
                {climateHasData ? copy.dataReady : copy.waiting}
              </span>
            </div>

            <div className="climate-readings">
              <div className="climate-reading temperature">
                <span className="climate-symbol" aria-hidden="true">°</span>
                <p>{copy.temperature}</p>
                <strong>
                  {temperature === null ? "—" : temperature.toFixed(1)}
                  <small> °C</small>
                </strong>
                <div className="reading-scale" aria-hidden="true">
                  <i
                    style={{
                      width: `${Math.min(
                        100,
                        Math.max(0, ((temperature ?? 0) / 50) * 100),
                      )}%`,
                    }}
                  />
                </div>
              </div>

              <div className="climate-reading humidity">
                <span className="climate-symbol drop" aria-hidden="true">◆</span>
                <p>{copy.humidity}</p>
                <strong>
                  {humidity === null ? "—" : humidity.toFixed(1)}
                  <small> %</small>
                </strong>
                <div className="reading-scale" aria-hidden="true">
                  <i
                    style={{
                      width: `${Math.min(100, Math.max(0, humidity ?? 0))}%`,
                    }}
                  />
                </div>
              </div>
            </div>

            <p className="climate-note" role="status">
              {climateHasData
                ? copy.climateOnline
                : connection === "connected"
                  ? copy.climateConnectedNoData
                  : copy.climateOffline}
            </p>
          </article>

          <article className="dht-wiring-card">
            <div className="feature-card-head light">
              <div>
                <p>{copy.threeWires}</p>
                <h3>{copy.connectModule}</h3>
              </div>
              <span className="feature-status pin">D2</span>
            </div>

            <div className="dht-visual" aria-hidden="true">
              <div className="dht-sensor">
                <span />
                <span />
                <span />
                <span />
                <b>DHT11</b>
              </div>
              <div className="dht-pins">
                <i className="signal" />
                <i className="power" />
                <i className="ground" />
              </div>
            </div>

            <div className="dht-connections">
              <div>
                <span className="connection-line signal" />
                <p><strong>S / DATA / OUT</strong><small>{copy.signalPin}</small></p>
                <b>D2</b>
              </div>
              <div>
                <span className="connection-line power" />
                <p><strong>+ / VCC</strong><small>{copy.powerPin}</small></p>
                <b>5V</b>
              </div>
              <div>
                <span className="connection-line ground" />
                <p><strong>− / GND</strong><small>{copy.groundPin}</small></p>
                <b>GND</b>
              </div>
            </div>

            <aside className="dht-warning">{copy.dhtWarning}</aside>
          </article>
        </div>
      </section>

      <section className="build-section" id="assembly">
        <div className="section-title">
          <p className="eyebrow">{copy.buildEyebrow}</p>
          <h2>{copy.buildTitle}</h2>
          <p>{copy.buildIntro}</p>
        </div>

        <div className="build-grid">
          <article className="parts-card">
            <h3>{copy.partsTitle}</h3>
            <ul className="parts-list">
              <li><span className="part-icon board">UNO</span><div><strong>Arduino UNO</strong><small>{copy.mainBoard}</small></div></li>
              <li><span className="part-icon servo">↻</span><div><strong>{copy.servoTitle}</strong><small>{copy.servoHint}</small></div></li>
              <li><span className="part-icon sonar">●●</span><div><strong>HC-SR04</strong><small>{copy.sonarHint}</small></div></li>
              <li><span className="part-icon buzzer">♫</span><div><strong>Passive Buzzer</strong><small>{copy.buzzerPartHint}</small></div></li>
              <li><span className="part-icon wires">100</span><div><strong>{copy.resistorTitle}</strong><small>{copy.resistorHint}</small></div></li>
              <li><span className="part-icon dht">DHT</span><div><strong>{copy.dhtTitle}</strong><small>{copy.dhtHint}</small></div></li>
            </ul>
          </article>

          <article className="wiring-card">
            <div className="wiring-head">
              <h3>{copy.wiringTitle}</h3>
              <span>{copy.existingPins}</span>
            </div>
            <div className="wiring-table">
              <div className="table-row table-head"><span>{copy.module}</span><span>{copy.contact}</span><span>Arduino</span></div>
              <div className="table-row"><span>SG90</span><span><i className="wire orange" />{copy.orange}</span><strong>D9</strong></div>
              <div className="table-row"><span>SG90</span><span><i className="wire red" />{copy.red}</span><strong>5V</strong></div>
              <div className="table-row"><span>SG90</span><span><i className="wire brown" />{copy.brown}</span><strong>GND</strong></div>
              <div className="table-row"><span>HC-SR04</span><span>VCC</span><strong>5V</strong></div>
              <div className="table-row"><span>HC-SR04</span><span>TRIG</span><strong>D7</strong></div>
              <div className="table-row"><span>HC-SR04</span><span>ECHO</span><strong>D6</strong></div>
              <div className="table-row"><span>HC-SR04</span><span>GND</span><strong>GND</strong></div>
              <div className="table-row new-wire"><span>Passive Buzzer</span><span>{copy.buzzerLong}</span><strong>D3</strong></div>
              <div className="table-row new-wire"><span>Passive Buzzer</span><span>{copy.buzzerShort}</span><strong>GND</strong></div>
              <div className="table-row climate-wire"><span>DHT11</span><span>S / DATA / OUT</span><strong>D2</strong></div>
              <div className="table-row climate-wire"><span>DHT11</span><span>+ / VCC</span><strong>5V</strong></div>
              <div className="table-row climate-wire"><span>DHT11</span><span>− / GND</span><strong>GND</strong></div>
            </div>
          </article>

          <article className="steps-card">
            <h3>{copy.stepsTitle}</h3>
            <ol className="steps-list">
              <li><span>1</span><div><strong>{copy.stepOneTitle}</strong><small>{copy.stepOneHint}</small></div></li>
              <li><span>2</span><div><strong>{copy.stepTwoTitle}</strong><small>{copy.stepTwoHint}</small></div></li>
              <li><span>3</span><div><strong>{copy.stepThreeTitle}</strong><small>{copy.stepThreeHint}</small></div></li>
              <li><span>4</span><div><strong>{copy.stepFourTitle}</strong><small>{copy.stepFourHint}</small></div></li>
            </ol>
            <div className="download-row">
              <a className="button primary" href="/arduino-smart-gate.ino" download>
                {copy.downloadCode}
              </a>
              <a className="text-link" href="/README-UK.md" download>
                {copy.instruction}
              </a>
            </div>
          </article>
        </div>

        <aside className="safety-note">
          <span aria-hidden="true">!</span>
          <p>
            <strong>{copy.safetyLabel}</strong> {copy.safetyText}
          </p>
        </aside>
      </section>
      </div>

      {activeTab === "game" && (
        <GamePanel
          connection={connection}
          error={error}
          isSupported={isSupported}
          language={language}
          joystickPressed={joystickPressed}
          joystickX={joystickX}
          joystickY={joystickY}
          onCommand={sendGameCommand}
          onConnect={() => void connect()}
          onDataSafetyChange={setGameDataAtRisk}
          onStartDemo={startDemo}
        />
      )}

      <footer>
        <div>
          <span className="brand-mark small" aria-hidden="true">∞</span>
          <p><strong>ARDUINO GATE</strong><small>{copy.footerMade}</small></p>
        </div>
        <p>
          {activeTab === "game"
            ? copy.footerGame
            : copy.footerControl}
        </p>
      </footer>

      {authAvailable && auth.consent === null && (
        <ConsentPanel
          copy={gameCopy}
          mode="banner"
          onChoose={handleConsentChoice}
        />
      )}

      {authAvailable && passwordResetOpen && (
        <PasswordResetDialog
          copy={gameCopy}
          onClose={() => setPasswordResetOpen(false)}
          onSubmit={auth.updatePassword}
        />
      )}
    </main>
  );
}

type PasswordResetCopy = Pick<
  PlayerStatsCopy,
  | "accountNewPasswordLabel"
  | "accountUpdatePassword"
  | "accountPasswordUpdated"
  | "accountPasswordTooShort"
  | "accountAuthError"
  | "cancelNicknameEdit"
>;

function PasswordResetDialog({
  copy,
  onClose,
  onSubmit,
}: {
  copy: PasswordResetCopy;
  onClose: () => void;
  onSubmit: (newPassword: string) => Promise<AuthActionResult>;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const titleId = "password-reset-title";
  const inputId = "password-reset-input";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || done) return;
    setDialogError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setDialogError(copy.accountPasswordTooShort);
      return;
    }
    setBusy(true);
    const result = await onSubmit(password);
    setBusy(false);
    if (!result.ok) {
      setDialogError(copy.accountAuthError);
      return;
    }
    setPassword("");
    setDone(true);
  };

  return (
    <AccountDialog labelledBy={titleId}>
      <h3 id={titleId}>{copy.accountUpdatePassword}</h3>
      {done ? (
        <>
          <p aria-live="polite" className="profile-result-status" role="status">
            {copy.accountPasswordUpdated}
          </p>
          <div className="account-dialog-actions">
            <button
              className="button primary"
              onClick={onClose}
              type="button"
            >
              {copy.cancelNicknameEdit}
            </button>
          </div>
        </>
      ) : (
        <form className="account-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor={inputId}>{copy.accountNewPasswordLabel}</label>
          <input
            autoComplete="new-password"
            data-dialog-initial-focus
            disabled={busy}
            id={inputId}
            minLength={MIN_PASSWORD_LENGTH}
            onChange={(event) => {
              setPassword(event.target.value);
              setDialogError(null);
            }}
            type="password"
            value={password}
          />
          {dialogError && (
            <p className="profile-error" role="alert">
              {dialogError}
            </p>
          )}
          <div className="account-dialog-actions">
            <button className="button primary" disabled={busy} type="submit">
              {copy.accountUpdatePassword}
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={onClose}
              type="button"
            >
              {copy.cancelNicknameEdit}
            </button>
          </div>
        </form>
      )}
    </AccountDialog>
  );
}
