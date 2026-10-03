import { useEffect, useRef, type RefObject } from "react";
import { normalizeJoystickAxis } from "./input";
import { createControllerNavigationState, nextFocusIndex, pollControllerNavigation, type NavigationDirection } from "./controllerNavigation";

const FOCUSABLE = "button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex='-1'])";

function availableControls(scope: HTMLElement) {
  return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) =>
    !element.matches(":disabled, [aria-disabled='true']") &&
    !element.closest("[inert], [hidden]") &&
    element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden",
  );
}

function adjustControl(element: HTMLElement, direction: NavigationDirection) {
  if (direction !== "left" && direction !== "right") return false;
  const amount = direction === "left" ? -1 : 1;
  if (element instanceof HTMLInputElement && element.type === "range") {
    const step = Number(element.step) || 1;
    const value = Math.min(Number(element.max) || 100, Math.max(Number(element.min) || 0, Number(element.value) + amount * step * 5));
    // Use the platform setter, then dispatch input so React sees a real change.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, String(value));
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  if (element instanceof HTMLSelectElement) {
    element.selectedIndex = Math.max(0, Math.min(element.options.length - 1, element.selectedIndex + amount));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  return false;
}

export function useControllerNavigation({ rootRef, connected, screen, x, y, pressed, centre, invertY, onBack, onPause }: {
  rootRef: RefObject<HTMLDivElement | null>;
  connected: boolean;
  screen: string;
  x: number;
  y: number;
  pressed: boolean;
  centre: { x: number; y: number };
  invertY: boolean;
  onBack: () => void;
  onPause: () => void;
}) {
  const latest = useRef({ connected, screen, x, y, pressed, centre, invertY, onBack, onPause });
  useEffect(() => { latest.current = { connected, screen, x, y, pressed, centre, invertY, onBack, onPause }; }, [connected, screen, x, y, pressed, centre, invertY, onBack, onPause]);

  useEffect(() => {
    const state = createControllerNavigationState();
    let frame = 0;
    let marked: HTMLElement | null = null;
    const clearMarker = () => { marked?.removeAttribute("data-controller-focus"); marked = null; };
    const mark = (element: HTMLElement) => {
      clearMarker();
      marked = element;
      element.setAttribute("data-controller-focus", "true");
      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    const tick = (now: number) => {
      const current = latest.current;
      const actions = pollControllerNavigation(state, {
        active: current.connected && document.visibilityState !== "hidden",
        screen: current.screen,
        x: normalizeJoystickAxis(current.x, current.centre.x),
        y: normalizeJoystickAxis(current.y, current.centre.y) * (current.invertY ? 1 : -1),
        pressed: current.pressed,
        now,
      });
      const root = rootRef.current;
      if (root) for (const action of actions) {
        if (action === "pause") { current.onPause(); break; }
        if (action === "back") { current.onBack(); break; }
        const scope = root.querySelector<HTMLElement>("[aria-modal='true']") ?? root;
        const controls = availableControls(scope);
        const active = document.activeElement;
        const index = controls.indexOf(active as HTMLElement);
        if (action === "activate") {
          if (index >= 0) { mark(controls[index]); controls[index].click(); }
          else if (controls[0]) mark(controls[0]);
          break;
        }
        if (index >= 0 && adjustControl(controls[index], action)) { mark(controls[index]); continue; }
        const next = nextFocusIndex(controls.map((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }), index, action);
        if (controls[next]) mark(controls[next]);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    document.addEventListener("pointerdown", clearMarker, true);
    document.addEventListener("keydown", clearMarker, true);
    return () => {
      cancelAnimationFrame(frame);
      clearMarker();
      document.removeEventListener("pointerdown", clearMarker, true);
      document.removeEventListener("keydown", clearMarker, true);
    };
  }, [rootRef]);
}
