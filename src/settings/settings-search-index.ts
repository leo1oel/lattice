import { useLingui } from "@lingui/react/macro";
import type { SettingsTab } from "../app-types";
import { fontLicenseUrl } from "virtual:lattice-private-fonts-license";
import { TIMELESS } from "./interface-font-credit";

/**
 * One searchable setting. `id` is the `data-setting` of the row it reveals;
 * a page-level entry has none and only opens its page. `terms` are the few
 * extra words people search for that the label does not say (its option
 * names, the tool it drives), localized like the label. `description` is
 * every description the row can show, one per state it switches between, so
 * a search for either wording finds it. Live statuses (the updater's and the
 * Overleaf live-editing connection's) are left out.
 */
export type SettingsSearchEntry = {
  tab: SettingsTab;
  label: string;
  /** Where it lives, shown under the label. */
  place: string;
  id?: string;
  terms?: string;
  description?: string;
};

/**
 * Every setting the host draws, in page order. The Agent pages belong to
 * Synara's embedded settings, which the host neither reads nor restyles, so
 * they are found by their page name alone and open as they always do.
 */
export function useSettingsSearchIndex(hasProject: boolean, knownAuthorName: string | null, livePreview = false): SettingsSearchEntry[] {
  const { t } = useLingui();
  const appearance = t`Appearance`;
  const editor = t`Editor & builds`;
  const literature = t`Literature services`;
  const overleaf = t`Overleaf`;
  // The Builds group's rows are found by its name too: "build" should reach the engine.
  const builds = t`Builds`;
  /* eslint-disable lingui/no-unlocalized-strings -- product and file names */
  return [
    { tab: "appearance", label: appearance, place: t`General` },
    { tab: "appearance", place: appearance, id: "interface-language", label: t`Interface language`, terms: `${t`English`} ${t`Simplified Chinese`}` },
    { tab: "appearance", place: appearance, id: "interface-size", label: t`Interface size`, terms: `${t({ message: "zoom scale bigger smaller", comment: "Search words for the Interface size setting, space-separated" })} ⌘+ ⌘− ⌘0` },
    { tab: "appearance", place: appearance, id: "editor-font-size", label: t`Source editor font size`, terms: t`Editor font size` },
    { tab: "appearance", place: appearance, id: "interface-sounds", label: t`Interface sounds`, terms: t({ message: "sound", comment: "Search words for the Interface sounds setting, space-separated" }) },
    { tab: "appearance", place: appearance, id: "toast-position", label: t`Notification position`, terms: `${t`Top right`} ${t`Top center`} ${t`Bottom right`} ${t`Bottom center`} ${t({ message: "toast notification", comment: "Search words for the Notification position setting, space-separated" })}` },
    { tab: "appearance", place: appearance, id: "color-theme", label: t`Color theme`, terms: `${t`Theme`} ${t`Light`} ${t`Dark`}` },
    { tab: "appearance", place: appearance, id: "theme-tint", label: t`Tint`, terms: `${t`Theme`} ${t`Graphite`} ${t({ message: "Paper", context: "theme tint" })} ${t`Sage`} ${t`Mist`} ${t`Dusk`}` },
    { tab: "appearance", place: appearance, id: "theme-accent", label: t`Accent`, terms: `${t`Theme`} ${t({ message: "color", comment: "Search words for the Accent setting, space-separated" })} ${t`Custom`}` },
    { tab: "appearance", place: appearance, id: "translucency", label: t`Translucency`, terms: t({ message: "frosted glass transparent vibrancy desktop", comment: "Search words for the Translucency setting, space-separated" }), description: `${t`Off while Reduce transparency is on in System Settings`} ${t`Only in the Lattice window on macOS`}` },
    { tab: "appearance", place: appearance, id: "code-theme", label: t`Code theme`, terms: `${t`Weft & Warp`} GitHub One Solarized Catppuccin Tokyo Night Dracula Nord Monokai ${t({ message: "syntax highlighting color scheme editor", comment: "Search words for the Code theme setting, space-separated" })}` },
    { tab: "appearance", place: appearance, id: "code-theme-variant", label: t`Light or dark`, terms: `${t`Code theme`} ${t`Match app`}` },
    { tab: "appearance", place: appearance, id: "titlebar-tools", label: t`Title bar tools` },
    { tab: "editor", label: editor, place: t`General` },
    { tab: "editor", place: editor, id: "editor-keymap", label: t`Editor keymap`, terms: `Vim Emacs ${t({ message: "shortcuts", comment: "Search words for the Editor keymap setting, space-separated" })}` },
    { tab: "editor", place: editor, id: "author-name", label: t`Your name`, terms: t`Comments`, description: t`Comments are signed ${knownAuthorName ?? ""}, from Git or Overleaf` },
    { tab: "editor", place: editor, id: "spellcheck", label: t`Check English spelling`, terms: `${t`Check spelling in prose`} Harper` },
    { tab: "editor", place: editor, id: "project-dictionary", label: t`Project dictionary`, terms: "Harper", description: t`Open a project to add terms` },
    { tab: "editor", place: editor, id: "auto-build", label: t`Automatic build`, terms: `${t`Manual only`} ⌘S` },
    { tab: "editor", place: editor, id: "aux-files", label: t`Auxiliary files`, terms: `${builds} ${t`Clean`} .aux .log` },
    ...(hasProject ? [
      { tab: "editor", place: editor, id: "compile-engine", label: t`Compile engine`, terms: `${builds} pdfLaTeX XeLaTeX LuaLaTeX latexmk`, description: t`A project latexmkrc overrides this` },
      { tab: "editor", place: editor, id: "shell-escape", label: t`Allow shell escape`, terms: `${builds} shell-escape ${t`Allow external commands`}` },
    ] satisfies SettingsSearchEntry[] : []),
    // Offered only to a LuaLaTeX project.
    ...(hasProject && livePreview ? [
      { tab: "editor", place: editor, id: "live-preview", label: t`Live preview`, terms: `${builds} LuaLaTeX rtex ${t({ message: "realtime instant", comment: "Search words for the Live preview setting, space-separated" })}` },
    ] satisfies SettingsSearchEntry[] : []),
    { tab: "editor", place: editor, id: "auto-updates", label: t`Automatic updates` },
    { tab: "editor", place: editor, id: "version", label: t`Version`, terms: t`Check for updates` },
    { tab: "agent", label: t`Providers`, place: t`Agent` },
    { tab: "mcp", label: t`MCP`, place: t`Agent` },
    { tab: "api", label: t`Skills`, place: t`Agent` },
    { tab: "overleaf", label: overleaf, place: t`Integrations` },
    { tab: "overleaf", place: overleaf, id: "overleaf-connection", label: t`Connection` },
    { tab: "overleaf", place: overleaf, id: "overleaf-sync-mode", label: t`Sync mode`, terms: `${t`Live sync`} ${t`Manual`}` },
    { tab: "overleaf", place: overleaf, id: "overleaf-remote-delete", label: t`When you delete a file here`, terms: `${t`Ask before deleting`} ${t`Delete on Overleaf too`} ${t`Keep it on Overleaf`}`, description: t`Overleaf history keeps a copy` },
    { tab: "literature", label: literature, place: t`Integrations` },
    ...[["openalex", "OpenAlex"], ["semanticscholar", "Semantic Scholar"], ["firecrawl", "Firecrawl"]].map(([id, name]) => (
      { tab: "literature", place: literature, id: `literature-${id}`, label: name, terms: t`API key` } satisfies SettingsSearchEntry
    )),
    { tab: "literature", place: literature, id: "literature-email", label: t`Contact email`, terms: "Crossref", description: t`Sent to Crossref` },
    { tab: "doctor", label: t`TeX doctor`, place: t`Diagnostics` },
    { tab: "logs", label: t`Logs`, place: t`Diagnostics` },
    {
      tab: "acknowledgements",
      label: t`Acknowledgements`,
      place: t`About`,
      terms: `${fontLicenseUrl ? `${TIMELESS.name} ` : ""}${t({ message: "credits licenses fonts open source libraries third-party notices", comment: "Search words for the Acknowledgements settings page, space-separated" })}`,
      ...(fontLicenseUrl ? { description: TIMELESS.license } : {}),
    },
  ];
  /* eslint-enable lingui/no-unlocalized-strings */
}

/** Stable across renders, which rebuild the entries. */
export const settingsEntryKey = (entry: SettingsSearchEntry) => `${entry.tab}:${entry.id ?? ""}`;

/**
 * The entries holding every word of `query`, labels that start with it first,
 * then labels that contain it, then the ones only their terms match, then the
 * ones that need their description; page order breaks ties.
 */
export function searchSettings(entries: readonly SettingsSearchEntry[], query: string): SettingsSearchEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  const words = needle.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return entries
    .map((entry, index) => {
      const label = entry.label.toLocaleLowerCase();
      const named = `${label} ${entry.terms?.toLocaleLowerCase() ?? ""}`;
      if (words.every((word) => named.includes(word))) {
        return { entry, index, rank: label.startsWith(needle) ? 0 : label.includes(needle) ? 1 : 2 };
      }
      const described = `${named} ${entry.description?.toLocaleLowerCase() ?? ""}`;
      return words.every((word) => described.includes(word)) ? { entry, index, rank: 3 } : null;
    })
    .filter((match) => match !== null)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((match) => match.entry);
}
