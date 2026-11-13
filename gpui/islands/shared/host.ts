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
