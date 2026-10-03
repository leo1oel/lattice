import { useLingui } from "@lingui/react/macro";
import type { SettingsTab } from "../app-types";

/**
 * One searchable setting. `id` is the `data-setting` of the row it reveals;
 * a page-level entry has none and only opens its page. `terms` are the few
 * extra words people search for that the label does not say (its option
 * names, the tool it drives), localized like the label. `description` is
 * every description the row can show, one per state it switches between, so
 * a search for either wording finds it; the updater's live status is left out.
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
export function useSettingsSearchIndex(hasProject: boolean, knownAuthorName: string | null): SettingsSearchEntry[] {
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
    { tab: "appearance", place: appearance, id: "color-theme", label: t`Color theme`, terms: `${t`Light`} ${t`Dark`}` },
    { tab: "appearance", place: appearance, id: "editor-font-size", label: t`Editor font size`, description: t`Source editor only` },
    { tab: "appearance", place: appearance, id: "interface-sounds", label: t`Interface sounds`, terms: t({ message: "sound", comment: "Search words for the Interface sounds setting, space-separated" }), description: t`When a build or Overleaf setup finishes` },
    { tab: "appearance", place: appearance, id: "titlebar-tools", label: t`Title bar tools` },
    { tab: "editor", label: editor, place: t`General` },
    { tab: "editor", place: editor, id: "editor-keymap", label: t`Editor keymap`, terms: `Vim Emacs ${t({ message: "shortcuts", comment: "Search words for the Editor keymap setting, space-separated" })}` },
    { tab: "editor", place: editor, id: "author-name", label: t`Your name`, terms: t`Comments`, description: `${t`Signs your comments when Git and Overleaf have no name`} ${t`Comments are signed ${knownAuthorName ?? ""}, from Git or Overleaf`}` },
    { tab: "editor", place: editor, id: "spellcheck", label: t`Check spelling in prose`, description: t`English, with Harper` },
    { tab: "editor", place: editor, id: "project-dictionary", label: t`Project dictionary`, description: `${t`Terms Harper should accept in this project`} ${t`Open a project to add terms`}` },
    { tab: "editor", place: editor, id: "auto-build", label: t`Automatic build`, description: `${t`Builds 1.2 s after you stop typing`} ${t`Build with ⌘S. Edits still save on their own`}` },
    { tab: "editor", place: editor, id: "aux-files", label: t`Auxiliary files`, terms: `${builds} ${t`Clean`}`, description: t`Removes .aux, .log and other build files` },
    ...(hasProject ? [
      { tab: "editor", place: editor, id: "compile-engine", label: t`Compile engine`, terms: `${builds} pdfLaTeX XeLaTeX LuaLaTeX latexmk`, description: t`A project latexmkrc overrides this` },
      { tab: "editor", place: editor, id: "shell-escape", label: t`Allow external commands`, terms: `${builds} shell-escape`, description: t`Shell escape during builds` },
    ] satisfies SettingsSearchEntry[] : []),
    { tab: "editor", place: editor, id: "auto-updates", label: t`Automatic updates` },
    { tab: "editor", place: editor, id: "version", label: t`Version`, terms: t`Check for updates` },
    { tab: "agent", label: t`Providers`, place: t`Agent` },
    { tab: "mcp", label: t`MCP`, place: t`Agent` },
    { tab: "api", label: t`Skills`, place: t`Agent` },
    { tab: "overleaf", label: overleaf, place: t`Integrations` },
    { tab: "overleaf", place: overleaf, id: "overleaf-connection", label: t`Connection` },
    { tab: "overleaf", place: overleaf, id: "overleaf-sync-mode", label: t`Sync mode`, description: `${t`Edits sync live with Overleaf`} ${t`Sync only when you click the sync button`}` },
    { tab: "overleaf", place: overleaf, id: "overleaf-remote-delete", label: t`When you delete a file here`, description: `${t`A sync asks first`} ${t`Overleaf history keeps a copy`} ${t`Overleaf keeps its copy`}` },
    { tab: "literature", label: literature, place: t`Integrations` },
    ...[["openalex", "OpenAlex"], ["semanticscholar", "Semantic Scholar"], ["firecrawl", "Firecrawl"]].map(([id, name]) => (
      { tab: "literature", place: literature, id: `literature-${id}`, label: name, terms: t`API key` } satisfies SettingsSearchEntry
    )),
    { tab: "literature", place: literature, id: "literature-email", label: t`Contact email`, description: t`Sent to Crossref for faster lookups. No key needed` },
    { tab: "doctor", label: t`TeX doctor`, place: t`Diagnostics` },
    { tab: "logs", label: t`Logs`, place: t`Diagnostics` },
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
