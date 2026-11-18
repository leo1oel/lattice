/**
 * Themes (`docs/themes.md`): the installed list, installing from a file,
 * applying the chosen one, and the accent fitting Settings shows. The theme is resolved by the app's Rust side
 * (`src-tauri/src/ipc/themes.rs`, over `src-tauri/lattice-theme`), the same
 * resolver and colour fitting the GPUI app runs, and comes back as the base
 * CSS variables to set on `<html>`; theme.css and foundations.css derive
 * every other role from those.
 *
 * The last answer for each choice is kept in localStorage, so a window opens
 * in its theme before the first IPC round trip and never shows a frame of
 * the default palette.
 */

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useReducer } from "react";

import { hostErrorMessage } from "../app-utils";
import { subscribeTauriEvent } from "../app/effect-helpers";

import type { Theme } from "./app-settings";
import type { ThemeAccent } from "./theme-customization";

export type ResolvedTheme = {
  /** The theme in effect, or null when none (or none for this appearance). */
  theme: string | null;
  variables: [string, string][];
  /** The accent in use when it is not the stylesheet's own. */
  accent: string | null;
};

export const THEMES_CHANGED_EVENT = "themes-changed";

export type ThemeVariantInfo = {
  id: string;
  name: string;
  appearance: Theme;
  window: string;
  chrome: string;
  panel: string;
  text: string;
  accent: string | null;
};

export type ThemeInfo = {
  id: string;
  name: string;
  version: string;
  author: string;
  license: string;
  description: string;
  source: "bundled" | "installed";
  variants: ThemeVariantInfo[];
};

export const installThemeFile = (path: string) => invoke<ThemeInfo>("themes_install_file", { path });
export const removeTheme = (id: string) => invoke<void>("themes_remove", { id });
export const revealThemesFolder = () => invoke<void>("themes_reveal_folder");

type ThemeList = { themes: ThemeInfo[] | null; error: string | null };

/**
 * The themes the writer can pick, kept current as any window installs or
 * removes one. `themes` is null until the first answer, and stays null in a
 * browser preview, which has no Rust side.
 */
export function useThemeList(): ThemeList {
  const [list, setList] = useReducer((_: ThemeList, next: ThemeList) => next, { themes: null, error: null });
  useEffect(() => {
    let active = true;
    const load = () => {
      invoke<ThemeInfo[]>("themes_list").then(
        (themes) => { if (active) setList({ themes, error: null }); },
        (reason: unknown) => { if (active) setList({ themes: null, error: hostErrorMessage(reason) }); },
      );
    };
    load();
    const unsubscribe = subscribeTauriEvent<unknown>(THEMES_CHANGED_EVENT, load);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return list;
}


type FittedAccent = { color: string; ratio: number };
const fitAccent = (color: string, appearance: Theme) =>
  invoke<FittedAccent>("themes_fit_accent", { color, appearance });

/**
 * A custom accent as the app will use it with no theme, and its contrast, for
 * the picker's note: the color itself until the answer arrives, and in a
 * browser preview, where there is no Rust side.
 */
export function useFittedAccent(color: string, appearance: Theme): FittedAccent {
  const [fitted, setFitted] = useReducer(
    (_: FittedAccent & { for: string }, next: FittedAccent & { for: string }) => next,
    { color, ratio: Number.NaN, for: "" },
  );
  const key = `${color}|${appearance}`;
  useEffect(() => {
    let current = true;
    fitAccent(color, appearance)
      .then((answer) => { if (current) setFitted({ ...answer, for: key }); })
      .catch(() => { if (current) setFitted({ color, ratio: Number.NaN, for: key }); });
    return () => {
      current = false;
    };
  }, [color, appearance, key]);
  return fitted.for === key ? fitted : { color, ratio: Number.NaN };
}

export type ThemeRequest = {
  theme: string;
  appearance: Theme;
  accent: ThemeAccent;
  /** A preset accent's colour in this appearance, read from the stylesheet. */
  presetColor: string | null;
};

export const resolveTheme = (request: ThemeRequest) =>
  invoke<ResolvedTheme>("themes_resolve", {
    request: { ...request, theme: request.theme || null },
  });

const CACHE_KEY = "lattice.theme-resolved.v1";
const CACHE_LIMIT = 16;

const cacheKey = (request: ThemeRequest) =>
  JSON.stringify([request.theme, request.appearance, request.accent, request.presetColor]);

function readCache(): Record<string, ResolvedTheme> {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as unknown;
    return value && typeof value === "object" ? value as Record<string, ResolvedTheme> : {};
  } catch {
    return {};
  }
}

/** The last answer for `request`, if this machine has seen one. */
export function cachedTheme(request: ThemeRequest): ResolvedTheme | undefined {
  const found = readCache()[cacheKey(request)];
  return found && Array.isArray(found.variables) ? found : undefined;
}

export function rememberTheme(request: ThemeRequest, resolved: ResolvedTheme): void {
  try {
    const entries = Object.entries(readCache()).filter(([key]) => key !== cacheKey(request));
    entries.push([cacheKey(request), resolved]);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries.slice(-CACHE_LIMIT))));
  } catch {
    // A full or blocked store only costs the first frame.
  }
}

/** Only variables of these families are ever set by a theme. */
const THEME_VARIABLE = /^--[a-z][a-z0-9-]*$/;

/**
 * Sets `variables` on `style`, removing the ones `previous` set that are
 * gone, and returns the names now set.
 */
export function applyThemeVariables(
  style: CSSStyleDeclaration,
  variables: readonly [string, string][],
  previous: ReadonlySet<string>,
  keep: ReadonlySet<string> = new Set(),
): Set<string> {
  const now = new Set<string>();
  for (const [name, value] of variables) {
    if (!THEME_VARIABLE.test(name) || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) continue;
    style.setProperty(name, value);
    now.add(name);
  }
  for (const name of previous) {
    if (!now.has(name) && !keep.has(name)) style.removeProperty(name);
  }
  return now;
}
