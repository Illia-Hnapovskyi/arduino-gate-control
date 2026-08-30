"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Two-layer immersive stage.
 *
 * Layer 1 is pure CSS: a class on `.space-game-root` turns the stage into a
 * fixed, full-viewport overlay and unpaints the site chrome. It works on every
 * engine, iPhone included, and it is the layer that makes the feature real.
 *
 * Layer 2 is the Fullscreen API on top of the same CSS, where the API exists.
 * It removes the browser's own UI as well. It is an enhancement, never a
 * precondition: a rejected request changes nothing the player can see.
 *
 * iOS Safari on iPhone has no Fullscreen API for non-`<video>` elements, so
 * layer 2 is simply skipped there — see `fullscreenApiAvailable`.
 */

type WebkitFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => void;
};

type WebkitFullscreenDocument = Document & {
  webkitExitFullscreen?: () => void;
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
};

/**
 * Feature detection by prototype, never by user agent.
 *
 * `@supports selector(:fullscreen)` is not an answer and neither is sniffing
 * for "iPhone": WebKit parses `:-webkit-full-screen` because it fullscreens
 * `<video>`, while `Element.prototype.requestFullscreen` is undefined, so an
 * element request there is not a rejected promise but a missing method. Both
 * halves are checked — the document must allow fullscreen AND an element must
 * have something to call.
 */
function fullscreenApiAvailable() {
  if (typeof document === "undefined" || typeof Element === "undefined") {
    return false;
  }
  const doc = document as WebkitFullscreenDocument;
  const allowed = doc.fullscreenEnabled === true || doc.webkitFullscreenEnabled === true;
  const prototype = Element.prototype as Partial<WebkitFullscreenElement>;
  const requestable =
    typeof prototype.requestFullscreen === "function" ||
    typeof prototype.webkitRequestFullscreen === "function";
  return allowed && requestable;
}

function currentFullscreenElement() {
  const doc = document as WebkitFullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** Hand a held fullscreen element back. Best effort by design: the CSS layer
 * comes off either way, so a rejection here is never worth surfacing. */
function releaseFullscreen() {
  const doc = document as WebkitFullscreenDocument;
  try {
    if (typeof doc.exitFullscreen === "function") {
      void doc.exitFullscreen().catch(() => undefined);
    } else {
      doc.webkitExitFullscreen?.();
    }
  } catch {
    // Nothing else to try.
  }
}

/**
 * Everything outside the overlay is painted over but still reachable: without
 * this, Tab walks out of a "full screen" game into a site header the player
 * cannot see, and one Enter on the Control tab ends the run. Real fullscreen
 * does this for us; the CSS-only layer — the one an iPhone always gets — has to
 * do it by hand, and doing it on both paths leaves one behaviour to reason
 * about. Only elements this call marked are ever unmarked, so an `inert` that
 * belonged to somebody else survives.
 */
function inertOutside(target: HTMLElement): HTMLElement[] {
  const held: HTMLElement[] = [];
  let node: HTMLElement = target;
  while (node !== document.body) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      if (sibling.inert) continue;
      sibling.inert = true;
      held.push(sibling);
    }
    node = parent;
  }
  return held;
}

/**
 * Every member here has a caller. An earlier draft also exported an
 * `isTransitioning()` grace window "so a blur must not pause", plus the
 * constant behind it — nothing ever consulted either, so the auto-pause on
 * `window` blur was unguarded while the code read as though it were guarded.
 * Wiring it up would have been the other half of a trade nobody had measured:
 * a blanket grace also swallows a genuine focus loss, so an unattended run
 * would keep flying. Removed rather than half-built; if a real engine is ever
 * shown to blur the window on a fullscreen transition, the guard belongs next
 * to a `document.hasFocus()` recheck, with a test that fails without it.
 */
export type ImmersiveStage = {
  /** Whether the immersive layer is on. Drives the label and `aria-pressed`. */
  active: boolean;
  /** Stable reader for effects that must not resubscribe on every toggle. */
  isActive: () => boolean;
  exit: () => void;
  toggle: () => void;
};

export function useImmersiveStage(
  targetRef: { current: HTMLElement | null },
): ImmersiveStage {
  const [active, setActive] = useState(false);
  const [apiAvailable] = useState(fullscreenApiAvailable);
  const activeRef = useRef(false);
  // Separate from `activeRef` on purpose: "the CSS layer is on" and "we hold a
  // real fullscreen element" are two different facts. Collapsing them makes a
  // rejected request indistinguishable from the player pressing Escape.
  const usedApiRef = useRef(false);
  // Bumped by every enter, every exit and by unmount. `requestFullscreen` is
  // asynchronous by specification — `document.fullscreenElement` is still null
  // when the call returns, and on macOS the transition takes hundreds of ms — so
  // an exit issued while a request is in flight has nothing to cancel. Without a
  // generation the request would then be granted to nobody: the document would
  // be fullscreen while `active` said it was not, the label would read "enter",
  // and Escape would pause the run instead of leaving the mode.
  const requestIdRef = useRef(0);
  const scrollRef = useRef({ x: 0, y: 0 });
  const inertedRef = useRef<HTMLElement[]>([]);

  const isActive = useCallback(() => activeRef.current, []);

  const releaseInert = useCallback(() => {
    for (const element of inertedRef.current) element.inert = false;
    inertedRef.current = [];
  }, []);

  const exit = useCallback(() => {
    requestIdRef.current += 1;
    releaseInert();
    if (usedApiRef.current && currentFullscreenElement()) releaseFullscreen();
    usedApiRef.current = false;
    activeRef.current = false;
    setActive(false);
    const { x, y } = scrollRef.current;
    // After layout settles, so the restored offset is not clamped against a
    // document that is still short.
    requestAnimationFrame(() => {
      window.scrollTo({ behavior: "instant", left: x, top: y });
    });
  }, [releaseInert]);

  const enter = useCallback(() => {
    scrollRef.current = { x: window.scrollX, y: window.scrollY };
    activeRef.current = true;
    setActive(true);
    const target = targetRef.current;
    if (target) inertedRef.current = inertOutside(target);
    if (!target || !apiAvailable) return;
    usedApiRef.current = true;
    const requestId = (requestIdRef.current += 1);
    const stale = () => requestIdRef.current !== requestId;
    try {
      if (typeof target.requestFullscreen === "function") {
        void target.requestFullscreen({ navigationUI: "hide" }).then(
          () => {
            // Granted — possibly after the player already left, in which case
            // the exit found nothing to cancel. Hand it straight back.
            if (stale()) releaseFullscreen();
          },
          () => {
            if (!stale()) usedApiRef.current = false;
          },
        );
      } else {
        (target as WebkitFullscreenElement).webkitRequestFullscreen?.();
      }
    } catch {
      usedApiRef.current = false;
    }
  }, [apiAvailable, targetRef]);

  const toggle = useCallback(() => {
    if (activeRef.current) exit();
    else enter();
  }, [enter, exit]);

  useEffect(() => {
    const followReality = () => {
      const element = currentFullscreenElement();
      // Our own element is fullscreen while the CSS layer is off: a request that
      // landed after the player had already left. The legacy webkit entry point
      // returns no promise, so it cannot check the generation itself — this is
      // where that path is corrected. Guarded on the element identity so a
      // <video> somebody else fullscreened is left alone.
      if (element && element === targetRef.current && !activeRef.current) {
        usedApiRef.current = false;
        releaseFullscreen();
        return;
      }
      if (!usedApiRef.current) return;
      if (element) return;
      // Escape, a system gesture or a tab switch dropped fullscreen. Take the
      // CSS layer off too, so one Escape is a complete exit instead of leaving
      // the player inside a fixed overlay.
      if (activeRef.current) exit();
      else usedApiRef.current = false;
    };
    document.addEventListener("fullscreenchange", followReality);
    document.addEventListener("webkitfullscreenchange", followReality);
    return () => {
      document.removeEventListener("fullscreenchange", followReality);
      document.removeEventListener("webkitfullscreenchange", followReality);
    };
  }, [exit, targetRef]);

  useEffect(
    () => () => {
      // The panel can be unmounted while immersive — switching to the control
      // tab does it — and an inert page would outlive the overlay that needed
      // it, leaving the site unusable until reload.
      for (const element of inertedRef.current) element.inert = false;
      inertedRef.current = [];
      // The CSS layer cannot outlive the element — it is selected through
      // `:has()` on an ancestor — but a real fullscreen element must be released
      // explicitly when the game tab unmounts. Bumping the generation first also
      // covers a request that is still in flight at this moment: its own
      // resolution handler sees a stale id and releases what it was granted.
      requestIdRef.current += 1;
      if (!usedApiRef.current) return;
      releaseFullscreen();
    },
    [],
  );

  return { active, exit, isActive, toggle };
}
