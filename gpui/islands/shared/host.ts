/**
 * The island page's view of the GPUI app: `window.latticeHost`, which the
 * island bridge (`gpui/crates/lattice-webview/assets/bridge.js`) injects into
 * the main frame before any of the page's own scripts run.
 *
 * Every island page in this package is built from the Tauri app's own modules
 * (`src/`), so it reaches the host the way those modules already do: through
 * Tauri's `invoke` (see `tauri-internals.ts`, which routes each call over the
 * bridge as a `tauri:invoke` request) and through the few island events below.
 */

import { useSyncExternalStore } from "react";

export type HostListener = (payload: unknown) => void;

export type LatticeHost = {
  readonly primaryIsMeta: boolean;
  post(type: string, payload?: unknown): void;
  request<T = unknown>(type: string, payload?: unknown): Promise<T>;
  on(type: string, listener: HostListener): () => void;
  ready(): void;
};

declare global {
  interface Window {
    latticeHost?: LatticeHost;
  }
}

/** The bridge, which only an island page has; a page opened elsewhere stops here. */
export function host(): LatticeHost {
  const bridge = window.latticeHost;
  if (!bridge) throw new Error("This page runs only inside a Lattice island.");
  return bridge;
}

/** What the host sends every island page when it opens a document in it. */
export type DocumentOpen<ViewState> = {
  path: string;
  source: string;
  viewState?: ViewState | null;
  locale: "en" | "zh-CN";
  active: boolean;
};

/**
 * The host's theme as the Tauri app keeps it on the root element
 * (`src/settings/use-appearance.ts`): `data-theme`, `data-tint`,
 * `data-accent`, and a custom accent as `--accent`. The bridge applies it
 * (`host:theme`); this reads what it applied.
 */
export function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Call `listener` with the theme whenever the host's changes it. */
export function onThemeChange(listener: (theme: "light" | "dark") => void): () => void {
  return host().on("host:theme", () => listener(currentTheme()));
}

const subscribeTheme = (changed: () => void) => onThemeChange(changed);

/** The host's light or dark, as the root element has it (the Tauri app's resolved `Theme`). */
export function useHostTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribeTheme, currentTheme);
}

/**
 * Run `callback` once the tree the page just committed has laid out: after
 * two animation frames while the page is seen, and after two tasks while it
 * is not. The host keeps a page unseen (its native view hidden) until it
 * says it has drawn (`doc:drawn`), and a hidden page gets no animation
 * frames, so waiting for frames alone would never end. The callback forces
 * the layout it reports on.
 */
export function afterLayout(callback: () => void): () => void {
  let cancelled = false;
  let frame = 0;
  const step = (remaining: number) => {
    if (cancelled) return;
    if (remaining === 0) {
      void document.documentElement.offsetHeight;
      callback();
      return;
    }
    if (document.visibilityState === "visible") {
      frame = requestAnimationFrame(() => step(remaining - 1));
    } else {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => step(remaining - 1);
      channel.port2.postMessage(null);
    }
  };
  step(2);
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}
