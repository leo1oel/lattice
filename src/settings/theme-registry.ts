/**
 * The theme marketplace's list, as lattice-core's registry client verifies
 * and caches it (`src-tauri/lattice-core/src/registry.rs`, docs/themes.md):
 * the IPC calls and what a Browse themes row offers.
 */
import { invoke } from "@tauri-apps/api/core";

import type { Theme } from "./app-settings";
import type { ArtVariant } from "./theme-art";
import type { ThemeInfo } from "./themes";

/** A kill-switch entry: `action` is "disable" (the theme is turned off) or "warn". */
export type BlockedEntry = {
  id: string;
  versions: string;
  action: string;
  reason: string;
  url: string | null;
};

export type IndexTheme = {
  id: string;
  name: string;
  version: string;
  author: string | null;
  license: string | null;
  description: string | null;
  repository: string;
  variants: { id: string; name: string | null; appearance: Theme; colors: Record<string, string> }[];
};

type RegistryStatus =
  | { kind: "cached" }
  | { kind: "fresh" }
  | { kind: "offline"; message: string }
  | { kind: "refused"; message: string };

export type RegistryListing = {
  index: { serial: number; generated: string; themes: IndexTheme[] } | null;
  /** The entry each listed theme's own version falls under, by id. */
  blockedOffers: Record<string, BlockedEntry>;
  /** When the shown list was fetched and verified. */
  fetchedAt: string | null;
  status: RegistryStatus;
  installed: { id: string; version: string; update: string | null; blocked: BlockedEntry | null }[];
};

/** The cached list, or the registry's after fetching and verifying it when `refresh`. */
export const registryIndex = (refresh: boolean) => invoke<RegistryListing>("registry_index", { refresh });
export const installRegistryTheme = (id: string) => invoke<ThemeInfo>("registry_install_theme", { id });

const NFKC = "NFKC" as const;
/** Full-width and half-width forms (Ａ, ｶ) fold to the ones a query types. */
const fold = (text: string) => text.normalize(NFKC).toLocaleLowerCase();

/**
 * Whether every word of `query` is in the theme's name, description or
 * author. Substrings, not word starts, so Chinese and Japanese text, which
 * has no spaces between words, matches anywhere.
 */
export function matchesQuery(theme: IndexTheme, query: string): boolean {
  const haystack = fold([theme.name, theme.description ?? "", theme.author ?? ""].join("\n"));
  return fold(query).split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

export type RowAction =
  | { kind: "install" }
  | { kind: "installed" }
  | { kind: "update"; version: string }
  | { kind: "blocked"; entry: BlockedEntry };

/** What a row offers for `theme`, given the list and the themes installed here. */
export function rowAction(theme: IndexTheme, listing: RegistryListing, installed: readonly ThemeInfo[] | null): RowAction {
  const entry = listing.blockedOffers[theme.id];
  if (entry) return { kind: "blocked", entry };
  const record = listing.installed.find((item) => item.id === theme.id);
  if (record?.update) return { kind: "update", version: record.update };
  if (record || installed?.some((item) => item.id === theme.id && item.version === theme.version)) return { kind: "installed" };
  return { kind: "install" };
}

/** A listed variant's base colors, for its tile: nothing downloads before Install. */
export function artVariants(theme: IndexTheme): ArtVariant[] {
  return theme.variants.map(({ appearance, colors }) => ({
    appearance,
    chrome: colors.chrome,
    panel: colors.panel,
    text: colors.text,
    accent: colors.accent,
  }));
}
