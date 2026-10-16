/**
 * Margin review's switch (View → Margin review): Auto, Markers only or Off,
 * kept per window, so one window can read with cards beside the text while
 * another keeps full-width text.
 *
 * A plain store rather than React state: App reads it to offer the palette
 * commands without a hook of its own, the native View menu shows it while a
 * window has margin review on screen, and the margin layer itself
 * (overleaf-margin-review.tsx, loaded with a linked Overleaf project) is the
 * only component that subscribes. Each window keeps its choice under its own
 * label, which the next window to take that label inherits.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listenInThisWindow } from "../app/window-events";
import { disposeWhenSettled } from "../app/effect-helpers";

export type MarginReviewMode = "auto" | "markers" | "off";

const MARGIN_REVIEW_MODES: readonly MarginReviewMode[] = ["auto", "markers", "off"];

const STORAGE_KEY = "lattice.margin-review.v1";
/** What the native View menu sends to the window it was chosen in (src-tauri/src/native_locale.rs). */
const MENU_EVENT = "margin-review-mode";

function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    // Tests and pages outside the app have one window.
    return "main";
  }
}

function readAll(): Record<string, MarginReviewMode> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, MarginReviewMode> : {};
  } catch {
    return {};
  }
}

function load(): MarginReviewMode {
  const stored = readAll()[windowLabel()];
  return MARGIN_REVIEW_MODES.includes(stored) ? stored : "auto";
}

const state: { mode: MarginReviewMode | null; layers: number } = { mode: null, layers: 0 };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export function marginReviewMode(): MarginReviewMode {
  state.mode ??= load();
  return state.mode;
}

export function setMarginReviewMode(mode: MarginReviewMode): void {
  if (mode === marginReviewMode()) return;
  state.mode = mode;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [windowLabel()]: mode }));
  } catch {
    // Unwritable storage keeps the choice for this session.
  }
  notify();
}

/** Called on a change of mode or of whether margin review is on screen. */
export function subscribeMarginReview(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether this window shows margin review now, which is when the View menu offers its switch. */
export function marginReviewAvailable(): boolean {
  return state.layers > 0;
}

/**
 * A margin layer is on screen: offer the switch in the View menu and take
 * the menu's choices in this window, until the returned function runs.
 */
export function registerMarginReviewLayer(): () => void {
  state.layers += 1;
  if (state.layers === 1) notify();
  const stopMenu = disposeWhenSettled(listenInThisWindow<string>(MENU_EVENT, ({ payload }) => {
    if ((MARGIN_REVIEW_MODES as readonly string[]).includes(payload)) setMarginReviewMode(payload as MarginReviewMode);
  }));
  return () => {
    stopMenu();
    state.layers -= 1;
    if (state.layers === 0) notify();
  };
}

const requests = new Set<() => void>();

/** "Review here" from the palette: the margin layer on screen opens the item by the caret. */
export function requestMarginReviewHere(): void {
  requests.forEach((request) => request());
}

export function onMarginReviewRequest(listener: () => void): () => void {
  requests.add(listener);
  return () => requests.delete(listener);
}
