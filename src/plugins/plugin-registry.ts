/**
 * The plugin market's list, as lattice-core's registry client verifies and
 * caches it beside the theme list (`src-tauri/lattice-core/src/registry.rs`,
 * docs/plugins.md): the IPC calls and what Settings › Plugins › Browse
 * offers for each listed plugin.
 */
import { invoke } from "@tauri-apps/api/core";

import { i18n } from "../i18n";
import type { BlockedEntry, RegistryStatus } from "../settings/theme-registry";
import type { PluginInfo, PluginPermissions } from "./plugin-ipc";

/** One plugin version as the signed index lists it (a snapshot of its manifest). */
export type IndexPlugin = {
  id: string;
  name: string;
  version: string;
  api: number;
  runtime: "node" | "exec";
  license: string;
  author: string | null;
  description: string | null;
  repository: string;
  categories: string[];
  permissions: PluginPermissions;
  commands: { id: string; title: string; description: string | null }[];
  size: number;
  downloads: number | null;
  /** When this version was published (ISO 8601). */
  updated: string | null;
};

type InstalledPlugin = {
  id: string;
  version: string;
  /** The listed version when it is newer and this Lattice can run it. */
  update: string | null;
  /** What that update asks for beyond the current grant: empty when it applies with one click. */
  updateAsks: PluginPermissions;
  blocked: BlockedEntry | null;
};

export type PluginListing = {
  plugins: IndexPlugin[];
  /** Whether the list shown is a verified one, so Browse can install from it. */
  verified: boolean;
  /** The entry each listed plugin's own version falls under, by id. */
  blockedOffers: Record<string, BlockedEntry>;
  fetchedAt: string | null;
  status: RegistryStatus;
  /** Every plugin installed from the list, with its update offer. */
  installed: InstalledPlugin[];
};

/** The cached list, or the registry's after fetching and verifying it when `refresh`. */
export const pluginRegistry = (refresh: boolean) => invoke<PluginListing>("plugins_registry", { refresh });
/** Install (or update to) the listed version; it stays off until the writer grants what it asks. */
export const installRegistryPlugin = (id: string) => invoke<PluginInfo>("plugins_install_registry", { id });

const NFKC = "NFKC" as const;
const fold = (text: string) => text.normalize(NFKC).toLocaleLowerCase();

/**
 * Whether every word of `query` is in the plugin's name, description,
 * author or categories. Substrings, so Chinese and Japanese text, which has
 * no spaces between words, matches anywhere.
 */
export function matchesPluginQuery(plugin: { name: string; description?: string | null; author?: string | null; categories?: string[]; id: string }, query: string): boolean {
  const haystack = fold([plugin.name, plugin.description ?? "", plugin.author ?? "", plugin.id, ...(plugin.categories ?? [])].join("\n"));
  return fold(query).split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

export type PluginSort = "popular" | "recent" | "name";

/** The list in Browse's order: most downloads, most recently published, or by name. */
export function sortPlugins(plugins: readonly IndexPlugin[], sort: PluginSort): IndexPlugin[] {
  const byName = (a: IndexPlugin, b: IndexPlugin) => a.name.localeCompare(b.name);
  const ordered = [...plugins];
  if (sort === "popular") return ordered.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0) || byName(a, b));
  if (sort === "recent") return ordered.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "") || byName(a, b));
  return ordered.sort(byName);
}

export type PluginOffer =
  | { kind: "install" }
  | { kind: "installed"; info: PluginInfo }
  | { kind: "update"; info: PluginInfo; version: string; asks: PluginPermissions }
  | { kind: "blocked"; entry: BlockedEntry };

/** What Browse offers for a listed plugin, given the plugins installed here (from any source). */
export function pluginOffer(plugin: IndexPlugin, listing: PluginListing, installed: readonly PluginInfo[]): PluginOffer {
  const entry = listing.blockedOffers[plugin.id];
  const info = installed.find((item) => item.id === plugin.id);
  if (entry && entry.action !== "warn" && !info) return { kind: "blocked", entry };
  if (!info) return { kind: "install" };
  const record = listing.installed.find((item) => item.id === plugin.id);
  if (record?.update) return { kind: "update", info, version: record.update, asks: record.updateAsks };
  return { kind: "installed", info };
}

/** `1.2K` downloads, in the interface language's compact form. */
export const compactCount = (count: number) => new Intl.NumberFormat(i18n.locale, { notation: "compact" }).format(count);

/** Whether a permission set grants nothing. */
export const asksNothing = (permissions: PluginPermissions) =>
  !permissions.projectRead.length && !permissions.networkLocal.length && !permissions.network.length && !permissions.secrets.length;
